"""Chromium runs the one HHTools GUI; WebRTC transports pixels and native input events."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import time
import uuid
from fractions import Fraction
from pathlib import Path
from urllib.parse import urlsplit

from hhtools.contracts.gui import GuiInput, GuiSessionRequest


def run_gui_worker(connection, origin, token, document, directory):
    if os.name == "posix":
        os.setsid()
    asyncio.run(_run(connection, origin, token, document, Path(directory)))


async def _run(connection, origin, token, document, directory):
    from aiortc import (
        RTCConfiguration,
        RTCIceServer,
        RTCPeerConnection,
        RTCSessionDescription,
        VideoStreamTrack,
    )
    from av import VideoFrame
    from PIL import Image
    from playwright.async_api import async_playwright

    from hhtools.application.process_executor import _receive, _send

    request = GuiSessionRequest.model_validate(document)
    browser = None
    peer = None
    driver = None
    pending = set()
    deadline = time.monotonic() + request.ttl_seconds
    channels = []
    chooser = None
    downloads = {}
    download_sizes = {}
    rejected_downloads = set()
    downloads_started = 0
    latest = None
    input_queue = asyncio.Queue(maxsize=256)
    keys = set()
    buttons = set()
    input_lock = asyncio.Lock()

    def emit(value):
        for channel in channels:
            if channel.readyState == "open" and channel.bufferedAmount < 65536:
                channel.send(json.dumps(value))

    def background(coroutine):
        task = asyncio.create_task(coroutine)
        pending.add(task)

        def completed(value):
            pending.discard(value)
            if not value.cancelled() and value.exception() is not None:
                emit({"error": "GUI_OPERATION_FAILED"})

        task.add_done_callback(completed)

    try:
        driver = await async_playwright().start()
        executable = os.environ.get("HHTOOLS_CHROMIUM_EXECUTABLE")
        context = await driver.chromium.launch_persistent_context(
            user_data_dir=str(directory / "profile"),
            headless=True,
            executable_path=executable,
            args=["--enable-unsafe-swiftshader"],
            downloads_path=str(directory / "incoming"),
            viewport={"width": request.width, "height": request.height},
            accept_downloads=True,
            ignore_https_errors=True,
            service_workers="block",
        )
        browser = context.browser
        browser_cdp = await browser.new_browser_cdp_session()
        context_ids = (await browser_cdp.send("Target.getBrowserContexts"))["browserContextIds"]
        await browser_cdp.send(
            "Browser.setDownloadBehavior",
            {
                "behavior": "allowAndName",
                "downloadPath": str(directory / "incoming"),
                "eventsEnabled": True,
                **({"browserContextId": context_ids[0]} if context_ids else {}),
            },
        )

        async def download_progress(event):
            identifier = event["guid"]
            if identifier in rejected_downloads:
                return
            download_sizes[identifier] = max(event["receivedBytes"], event["totalBytes"])
            if sum(download_sizes.values()) > 4 * 1024**3:
                rejected_downloads.add(identifier)
                download_sizes.pop(identifier, None)
                await browser_cdp.send("Browser.cancelDownload", {"guid": identifier})
                emit({"error": "DOWNLOAD_BUDGET_EXCEEDED"})

        browser_cdp.on(
            "Browser.downloadProgress", lambda event: background(download_progress(event))
        )
        own = urlsplit(origin)
        await context.add_cookies(
            [
                {
                    "name": "hhtools_gui_session",
                    "value": token,
                    "url": origin,
                    "httpOnly": True,
                    "secure": own.scheme == "https",
                    "sameSite": "Strict",
                }
            ]
        )

        async def route_request(route):
            url = urlsplit(route.request.url)
            if (url.scheme, url.netloc) != (own.scheme, own.netloc):
                await route.abort("blockedbyclient")
                return
            await route.continue_()

        await context.route("**/*", route_request)
        page = context.pages[0] if context.pages else await context.new_page()
        page.set_default_timeout(10000)
        context.on("page", lambda popup: background(popup.close()) if popup != page else None)

        async def choose(value):
            nonlocal chooser
            chooser = {
                "chooser_id": uuid.uuid4().hex,
                "multiple": value.is_multiple(),
                "directory": bool(await value.element.get_attribute("webkitdirectory") is not None),
                "handle": value,
            }
            emit({"chooser": {key: value for key, value in chooser.items() if key != "handle"}})

        async def download(value):
            nonlocal downloads_started
            if downloads_started >= 32:
                await value.cancel()
                emit({"error": "DOWNLOAD_BUDGET_EXCEEDED"})
                return
            downloads_started += 1
            identifier = uuid.uuid4().hex
            destination = directory / "downloads" / identifier
            destination.parent.mkdir(exist_ok=True)
            await value.save_as(destination)
            await value.delete()
            downloads[identifier] = {
                "download_id": identifier,
                "filename": Path(value.suggested_filename).name,
                "size_bytes": destination.stat().st_size,
            }
            emit({"download": downloads[identifier]})

        page.on("filechooser", lambda value: background(choose(value)))
        page.on("download", lambda value: background(download(value)))
        await page.goto(origin, wait_until="domcontentloaded")
        await page.locator("#app-root > *").first.wait_for()
        cdp = await context.new_cdp_session(page)

        async def capture(event):
            nonlocal latest
            latest = event["data"]
            await cdp.send("Page.screencastFrameAck", {"sessionId": event["sessionId"]})

        cdp.on("Page.screencastFrame", lambda event: background(capture(event)))
        await cdp.send(
            "Page.startScreencast",
            {
                "format": "jpeg",
                "quality": 85,
                "maxWidth": 1920,
                "maxHeight": 1080,
                "everyNthFrame": 1,
            },
        )

        async def input_event(event):
            if event.action == "move":
                await page.mouse.move(event.x, event.y)
            elif event.action in {"down", "up"}:
                await page.mouse.move(event.x, event.y)
                if event.action == "down":
                    await page.mouse.down(button=event.button)
                    buttons.add(event.button)
                else:
                    await page.mouse.up(button=event.button)
                    buttons.discard(event.button)
            elif event.action == "wheel":
                await page.mouse.move(event.x, event.y)
                await page.mouse.wheel(event.delta_x, event.delta_y)
            elif event.action == "key_down":
                await page.keyboard.down(event.key)
                keys.add(event.key)
            elif event.action == "key_up":
                await page.keyboard.up(event.key)
                keys.discard(event.key)
            elif event.action == "text":
                await page.keyboard.insert_text(event.text)
            elif event.action == "resize":
                await page.set_viewport_size({"width": event.width, "height": event.height})
            elif event.action == "release":
                for key in list(keys):
                    await page.keyboard.up(key)
                for button in list(buttons):
                    await page.mouse.up(button=button)
                keys.clear()
                buttons.clear()

        async def input_loop():
            while True:
                event = await input_queue.get()
                try:
                    async with input_lock:
                        await input_event(event)
                except Exception:
                    emit({"error": "INVALID_GUI_INPUT"})

        background(input_loop())
        _send(connection, {"ready": True, "frame_count": 1, "duration_seconds": 0})
        deadline = time.monotonic() + request.ttl_seconds
        while time.monotonic() < deadline:
            if not connection.poll():
                await asyncio.sleep(0.02)
                continue
            command = _receive(connection)
            operation = command["operation"]
            try:
                if operation == "close":
                    _send(connection, {"closed": True})
                    break
                if operation == "renew":
                    deadline = time.monotonic() + request.ttl_seconds
                    response = {"renewed": True}
                elif operation == "status":
                    response = {
                        "connection_state": peer.connectionState if peer else "new",
                        "chooser": {k: v for k, v in chooser.items() if k != "handle"}
                        if chooser
                        else None,
                        "downloads": list(downloads.values()),
                        "width": page.viewport_size["width"],
                        "height": page.viewport_size["height"],
                    }
                elif operation == "input":
                    await input_queue.put(GuiInput.model_validate(command["input"]))
                    response = {"accepted": True}
                elif operation == "snapshot":
                    await page.screenshot(path=directory / "snapshot.png")
                    response = {
                        "width": page.viewport_size["width"],
                        "height": page.viewport_size["height"],
                    }
                elif operation == "drop":
                    data = {
                        "items": [],
                        "files": [str(path) for path in Path(command["root"]).iterdir()],
                        "dragOperationsMask": 1,
                    }
                    for event_type in ("dragEnter", "dragOver", "drop"):
                        await cdp.send(
                            "Input.dispatchDragEvent",
                            {
                                "type": event_type,
                                "x": command["x"],
                                "y": command["y"],
                                "data": data,
                            },
                        )
                    response = {"accepted": True}
                elif operation == "files":
                    if chooser is None or chooser["chooser_id"] != command["chooser_id"]:
                        response = {"error": "GUI_CHOOSER_EXPIRED"}
                    else:
                        files = command["files"]
                        if chooser["directory"]:
                            roots = list(Path(command["root"]).iterdir())
                            files = (
                                str(roots[0])
                                if len(roots) == 1 and roots[0].is_dir()
                                else command["root"]
                            )
                        await chooser["handle"].set_files(files)
                        chooser = None
                        emit({"chooser": None})
                        response = {"accepted": True}
                elif operation == "download":
                    response = downloads.get(
                        command["download_id"], {"error": "DOWNLOAD_NOT_FOUND"}
                    )
                elif operation == "offer":
                    if peer is not None:
                        await peer.close()
                    async with input_lock:
                        while not input_queue.empty():
                            input_queue.get_nowait()
                        await input_event(GuiInput(action="release"))
                    channels.clear()
                    servers = [
                        RTCIceServer(**item)
                        for item in json.loads(os.environ.get("HHTOOLS_ICE_SERVERS", "[]"))
                    ]
                    peer = RTCPeerConnection(RTCConfiguration(iceServers=servers))

                    class AppTrack(VideoStreamTrack):
                        def __init__(self):
                            super().__init__()
                            self.started = time.monotonic()
                            self.sequence = 0

                        async def recv(self):
                            nonlocal latest
                            while latest is None:
                                await asyncio.sleep(0.02)
                            await asyncio.sleep(
                                max(
                                    0, self.started + self.sequence / request.fps - time.monotonic()
                                )
                            )
                            self.sequence = max(
                                self.sequence, int((time.monotonic() - self.started) * request.fps)
                            )
                            with Image.open(io.BytesIO(base64.b64decode(latest))) as image:
                                frame = VideoFrame.from_image(image.convert("RGB"))
                            frame.pts = self.sequence * 90000 // request.fps
                            frame.time_base = Fraction(1, 90000)
                            self.sequence += 1
                            return frame

                    @peer.on("datachannel")
                    def datachannel(channel):
                        channels.append(channel)

                        @channel.on("message")
                        def message(value):
                            if not isinstance(value, str) or len(value) > 65536:
                                return
                            try:
                                event = GuiInput.model_validate_json(value)
                                input_queue.put_nowait(event)
                            except (ValueError, asyncio.QueueFull):
                                emit({"error": "GUI_INPUT_REJECTED"})

                    peer.addTrack(AppTrack())
                    await peer.setRemoteDescription(
                        RTCSessionDescription(sdp=command["sdp"], type="offer")
                    )
                    await peer.setLocalDescription(await peer.createAnswer())
                    response = {"type": "answer", "sdp": peer.localDescription.sdp}
                else:
                    response = {"error": "GUI_OPERATION_UNSUPPORTED"}
                _send(connection, response)
            except Exception:
                _send(connection, {"error": "GUI_OPERATION_FAILED"})
    except BaseException as error:
        import traceback

        (directory / "failure.log").write_text(traceback.format_exc(), encoding="utf-8")
        try:
            _send(
                connection, {"error": "GUI_BACKEND_FAILED", "exception_type": type(error).__name__}
            )
        except (OSError, EOFError):
            pass
    finally:
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if peer is not None:
            await peer.close()
        if browser is not None:
            await browser.close()
        if driver is not None:
            await driver.stop()
        connection.close()
