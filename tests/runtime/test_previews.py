"""Real offscreen pixels and WebRTC media independent of Runtime/job lifetime."""

from __future__ import annotations

import asyncio
import io
import os
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from hhtools.application.runtime import ApplicationPaths
from hhtools.io.npz import save_npz
from hhtools.runtime.server import create_runtime_app

PREFIX = "/api/runtime/v1"

RENDER_AVAILABLE = Path("/dev/nvidia0").exists() or os.environ.get("HHTOOLS_TEST_RENDER") == "1"
requires_render = pytest.mark.skipif(
    not RENDER_AVAILABLE, reason="requires an offscreen rendering device"
)


def test_sdp_keeps_required_terminal_crlf():
    from hhtools.contracts.previews import PreviewAnswer, PreviewOffer

    sdp = "v=0\r\na=setup:active\r\n"
    assert PreviewOffer(sdp=sdp).sdp == sdp
    assert PreviewAnswer(sdp=sdp).sdp == sdp


@pytest.fixture
def preview_client(tmp_path, synthetic_terrain_motion):
    app = create_runtime_app(ApplicationPaths.isolated(tmp_path))
    motion = synthetic_terrain_motion
    motion.terrain = None
    motion.meta = {}
    motion.positions = np.repeat(motion.positions, 30, axis=0)
    motion.positions[:, :, 0] += np.linspace(0, 0.6, 30)[:, None]
    motion.positions[:, 6, 2] += np.linspace(0, 0.35, 30)
    motion.quaternions = np.repeat(motion.quaternions, 30, axis=0)
    save_npz(motion, app.state.application_runtime.paths.source_root / "motion.npz")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1234)) as client:
        asset = client.post(
            "/api/agent/v1/assets", json={"root_id": "source", "relative_path": "motion.npz"}
        ).json()
        yield client, asset


@requires_render
def test_scene_data_and_real_png_share_resource_identity(preview_client):
    client, asset = preview_client
    response = client.post(
        PREFIX + "/previews",
        json={
            "source": {"asset_id": asset["asset_id"]},
            "mode": "data",
            "width": 480,
            "height": 360,
        },
    )
    assert response.status_code == 200, response.text
    session = response.json()
    session_id = session["session_id"]
    path = PREFIX + f"/previews/{session_id}"
    data = client.get(path + "/data").json()
    assert data["source"]["asset_id"] == asset["asset_id"]
    assert data["coordinates"]["quaternion_order"] == "xyzw"
    first = client.get(path + "/snapshot?frame=0")
    assert first.status_code == 200, first.text[:100]
    image = np.asarray(Image.open(io.BytesIO(first.content)))
    assert image.shape == (360, 480, 3)
    assert image.std() > 10
    second = np.asarray(Image.open(io.BytesIO(client.get(path + "/snapshot?frame=29").content)))
    assert np.mean(np.abs(image.astype(float) - second)) > 0.5
    assert client.delete(path).json()["state"] == "closed"
    assert client.get(PREFIX + "/identity").status_code == 200
    assert client.get("/api/agent/v1/assets/" + asset["asset_id"]).status_code == 200


@requires_render
def test_webrtc_delivers_moving_frames(preview_client):
    aiortc = pytest.importorskip("aiortc")
    client, asset = preview_client
    response = client.post(
        PREFIX + "/previews",
        json={
            "source": {"asset_id": asset["asset_id"]},
            "mode": "webrtc",
            "width": 480,
            "height": 360,
        },
    )
    assert response.status_code == 200, response.text
    path = PREFIX + "/previews/" + response.json()["session_id"]

    async def receive_video():
        peer = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=[]))
        track_future = asyncio.get_running_loop().create_future()

        @peer.on("track")
        def track_arrived(track):
            if track.kind == "video" and not track_future.done():
                track_future.set_result(track)

        peer.addTransceiver("video", direction="recvonly")
        channel = peer.createDataChannel("viewport")
        try:
            await peer.setLocalDescription(await peer.createOffer())
            answer = await asyncio.to_thread(
                client.post,
                path + "/offer",
                json={"type": "offer", "sdp": peer.localDescription.sdp},
            )
            assert answer.status_code == 200, answer.text
            await peer.setRemoteDescription(aiortc.RTCSessionDescription(**answer.json()))
            track = await asyncio.wait_for(track_future, 10)
            frames = [await asyncio.wait_for(track.recv(), 10) for _ in range(10)]
            first, last = (
                frames[0].to_ndarray(format="rgb24"),
                frames[-1].to_ndarray(format="rgb24"),
            )
            assert first.std() > 10
            assert np.mean(np.abs(first.astype(float) - last)) > 0.2
            assert channel.readyState == "open"
        finally:
            await peer.close()

    try:
        asyncio.run(receive_video())
    finally:
        client.delete(path)
    assert client.get(PREFIX + "/identity").status_code == 200


@pytest.mark.parametrize("format", ["png", "mp4"])
@requires_render
def test_render_job_publishes_real_image_or_video(preview_client, format):
    pytest.importorskip("av")
    client, asset = preview_client
    plan = client.post(
        PREFIX + "/workflows/preview-render/preflight",
        json={
            "source": {"asset_id": asset["asset_id"]},
            "format": format,
            "width": 320,
            "height": 240,
            "frames": 8,
        },
    )
    assert plan.status_code == 200, plan.text
    job = client.post(
        PREFIX + "/jobs",
        json={"plan_id": plan.json()["plan_id"], "idempotency_key": "render-" + format},
    ).json()
    deadline = time.monotonic() + 20
    while job["state"] in {"queued", "running"} and time.monotonic() < deadline:
        time.sleep(0.05)
        job = client.get(PREFIX + "/jobs/" + job["job_id"]).json()
    assert job["state"] == "completed", job
    artifact = next(
        item
        for item in job["artifacts"]
        if item["kind"] == ("preview_image" if format == "png" else "preview_video")
    )
    payload = client.get(
        PREFIX + f"/jobs/{job['job_id']}/artifacts/{artifact['artifact_id']}/content"
    ).content
    if format == "png":
        assert np.asarray(Image.open(io.BytesIO(payload))).std() > 10
    else:
        import av

        with av.open(io.BytesIO(payload)) as container:
            frames = list(container.decode(video=0))
            assert len(frames) == 8
            assert frames[0].to_ndarray(format="rgb24").std() > 10


@requires_render
def test_preview_preserves_registered_object_mesh_and_terrain(tmp_path, synthetic_terrain_motion):
    import trimesh
    from hhtools.core.scene import SceneObject

    paths = ApplicationPaths.isolated(tmp_path)
    paths.source_root.mkdir(parents=True)
    trimesh.creation.box(extents=[0.25, 0.25, 0.25]).export(paths.source_root / "box.obj")
    motion = synthetic_terrain_motion
    motion.objects = [
        SceneObject(
            name="box",
            positions=np.array([[0.4, 0.3, 0.6]], dtype=np.float32),
            quaternions=np.array([[0, 0, 0, 1]], dtype=np.float32),
            extents=np.array([0.25, 0.25, 0.25]),
            mesh_path="box.obj",
        )
    ]
    save_npz(motion, paths.source_root / "scene.npz")
    app = create_runtime_app(paths)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1234)) as client:
        registered = client.post(
            "/api/agent/v1/assets", json={"root_id": "source", "relative_path": "scene.npz"}
        )
        assert registered.status_code == 201, registered.text
        session = client.post(
            PREFIX + "/previews",
            json={"source": {"asset_id": registered.json()["asset_id"]}, "mode": "data"},
        )
        assert session.status_code == 200, session.text
        path = PREFIX + "/previews/" + session.json()["session_id"]
        data = client.get(path + "/data").json()
        assert data["motion"]["terrain"]["vertices"]
        assert data["motion"]["objects"][0]["geometry_detail"] == "mesh"
        snapshot = client.get(path + "/snapshot")
        assert snapshot.status_code == 200, snapshot.text[:200]
        pixels = np.asarray(Image.open(io.BytesIO(snapshot.content))).astype(float)
        assert (
            (pixels[:, :, 0] > pixels[:, :, 1] * 1.2) & (pixels[:, :, 1] > pixels[:, :, 2] * 1.2)
        ).sum() > 20
