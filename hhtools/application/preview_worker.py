"""Dedicated preview process: local scene loop, WebRTC media, and bounded control IPC."""

from __future__ import annotations

import asyncio
import json
import os
import time
from fractions import Fraction
from pathlib import Path

from hhtools.contracts.previews import PreviewCreateRequest, PreviewInput


def run_preview_worker(connection, paths, request_document, directory):
    os.environ.setdefault("MUJOCO_GL", "egl")
    if os.name == "posix":
        os.setsid()
    asyncio.run(_run(connection, paths, request_document, Path(directory)))


async def _run(connection, paths, request_document, directory):
    from hhtools.application.preview_renderer import PreviewRenderer
    from hhtools.application.preview_scene import PreviewScene
    from hhtools.application.process_executor import _receive, _send
    from hhtools.application.state import _cleanup_session_state
    from hhtools.application.worker_resources import build_worker_services

    state = None
    scene = None
    renderer = None
    peer = None
    deadline = time.monotonic() + request_document["ttl_seconds"]
    try:
        request = PreviewCreateRequest.model_validate(request_document)
        state, services = build_worker_services(paths, directory)
        scene = PreviewScene(paths, services, request.source)
        (directory / "scene.json").write_text(
            json.dumps(scene.data, allow_nan=False), encoding="utf-8"
        )
        if request.mode == "webrtc":
            renderer = PreviewRenderer(scene, request.width, request.height)
            renderer.render(frame=0)
        deadline = time.monotonic() + request.ttl_seconds
        _send(
            connection,
            {"ready": True, "frame_count": scene.frame_count, "duration_seconds": scene.duration},
        )
        while time.monotonic() < deadline:
            if not connection.poll():
                await asyncio.sleep(0.02)
                continue
            command = _receive(connection)
            operation = command["operation"]
            if operation == "close":
                _send(connection, {"closed": True})
                break
            if operation == "renew":
                deadline = time.monotonic() + request.ttl_seconds
                _send(connection, {"renewed": True})
                continue
            if operation == "status":
                _send(
                    connection,
                    {
                        "frame": renderer.frame if renderer else 0,
                        "connection_state": peer.connectionState if peer else "new",
                    },
                )
                continue
            if operation == "snapshot":
                from PIL import Image

                if renderer is None:
                    renderer = PreviewRenderer(scene, request.width, request.height)
                Image.fromarray(renderer.render(frame=command.get("frame", 0))).save(
                    directory / "snapshot.png"
                )
                _send(
                    connection,
                    {"frame": renderer.frame, "width": request.width, "height": request.height},
                )
                continue
            if operation == "input":
                if renderer is not None:
                    renderer.input(PreviewInput.model_validate(command["input"]))
                _send(connection, {"accepted": renderer is not None})
                continue
            if operation != "offer" or request.mode != "webrtc":
                _send(connection, {"error": "PREVIEW_OPERATION_UNSUPPORTED"})
                continue
            from aiortc import (
                RTCConfiguration,
                RTCIceServer,
                RTCPeerConnection,
                RTCSessionDescription,
                VideoStreamTrack,
            )
            from av import VideoFrame

            if peer is not None:
                await peer.close()
            servers = [
                RTCIceServer(**item)
                for item in json.loads(os.environ.get("HHTOOLS_ICE_SERVERS", "[]"))
            ]
            peer = RTCPeerConnection(RTCConfiguration(iceServers=servers))

            class SceneTrack(VideoStreamTrack):
                def __init__(self, surface, channels):
                    super().__init__()
                    self.sequence = 0
                    self.started = time.monotonic()
                    self.surface = surface
                    self.channels = channels

                async def recv(self):
                    due = self.started + self.sequence / request.fps
                    await asyncio.sleep(max(0, due - time.monotonic()))
                    # Skip overdue frames; never queue stale rendered images.
                    self.sequence = max(
                        self.sequence, int((time.monotonic() - self.started) * request.fps)
                    )
                    video = VideoFrame.from_ndarray(self.surface.render(), format="rgb24")
                    if self.sequence % 6 == 0:
                        for channel in self.channels:
                            if channel.readyState == "open":
                                channel.send(json.dumps({"frame": self.surface.frame}))
                    video.pts = self.sequence * 90000 // request.fps
                    video.time_base = Fraction(1, 90000)
                    self.sequence += 1
                    return video

            view_channels = []

            @peer.on("datachannel")
            def datachannel(channel, surface=renderer, channels=view_channels):
                channels.append(channel)

                @channel.on("message")
                def message(value):
                    if not isinstance(value, str) or len(value) > 4096:
                        return
                    try:
                        event = PreviewInput.model_validate_json(value)
                        surface.input(event)
                        channel.send(
                            json.dumps(
                                {
                                    "sequence": event.sequence,
                                    "frame": surface.frame,
                                    "acknowledged": True,
                                }
                            )
                        )
                    except ValueError:
                        channel.send(json.dumps({"error": "INVALID_VIEW_INPUT"}))

            peer.addTrack(SceneTrack(renderer, view_channels))
            await peer.setRemoteDescription(RTCSessionDescription(sdp=command["sdp"], type="offer"))
            await peer.setLocalDescription(await peer.createAnswer())
            _send(connection, {"type": "answer", "sdp": peer.localDescription.sdp})
    except BaseException as error:
        import traceback

        (directory / "failure.log").write_text(traceback.format_exc(), encoding="utf-8")
        try:
            public = getattr(error, "api_error", None)
            _send(
                connection,
                {
                    "error": public.code if public is not None else "PREVIEW_BACKEND_FAILED",
                    "exception_type": type(error).__name__,
                },
            )
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        if peer is not None:
            await peer.close()
        if renderer is not None:
            renderer.close()
        if scene is not None:
            scene.close()
        if state is not None:
            _cleanup_session_state(state)
        connection.close()
