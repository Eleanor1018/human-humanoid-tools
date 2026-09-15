"""Exercise real Chromium input, file choosers and downloads across the GUI worker."""

import importlib.util
import io
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import numpy as np
import pytest
from PIL import Image

from hhtools.application.gui_sessions import GuiSessions
from hhtools.application.runtime import ApplicationPaths
from hhtools.contracts.gui import GuiSessionRequest, GuiUploadRequest
from hhtools.services.runtime_control import RuntimeControl, RuntimeServiceError


@pytest.mark.skipif(
    importlib.util.find_spec("playwright") is None, reason="requires streaming extra and Chromium"
)
def test_browser_session_transfers_and_cleanup(tmp_path):
    received = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            parsed = urlsplit(self.path)
            if parsed.path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            if parsed.path == "/":
                body = b"""<!doctype html><html><body style="margin:0;background:#ddeaf0">
                <div id="app-root">
                <input style="position:absolute;top:16px;left:16px;width:180px;height:28px"
                  oninput="fetch('/api/value?text='+encodeURIComponent(this.value))">
                <input type="file" style="position:absolute;top:80px;left:16px"
                  onchange="fetch('/api/uploaded?name='+encodeURIComponent(this.files[0].name))">
                <a href="/api/download" download
                  style="position:absolute;top:140px;left:16px">Download</a>
                </div></body></html>"""
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
            else:
                assert (
                    SimpleCookie(self.headers.get("Cookie", "")).get("hhtools_gui_session")
                    is not None
                )
                received.append((parsed.path, parse_qs(parsed.query)))
                body = b"GUI transfer bytes"
                self.send_response(200)
                if parsed.path == "/api/download":
                    self.send_header("Content-Disposition", 'attachment; filename="hello.txt"')
                self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    control = RuntimeControl(tmp_path / "control")
    sessions = GuiSessions(ApplicationPaths.isolated(tmp_path), control)
    sessions.origin = f"http://127.0.0.1:{server.server_port}"

    def until(check):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            result = check()
            if result:
                return result
            time.sleep(0.05)
        pytest.fail("GUI state did not arrive")

    try:
        session = sessions.create(GuiSessionRequest(width=640, height=480), "operator")
        identifier = session["session_id"]
        assert sessions.create(GuiSessionRequest(), "operator")["session_id"] == identifier
        with pytest.raises(RuntimeServiceError, match="another operator"):
            sessions.create(GuiSessionRequest(), "other")

        def command(**event):
            return sessions.rpc(identifier, "operator", "input", input=event)

        def click(x, y):
            command(action="down", x=x, y=y)
            command(action="up", x=x, y=y)

        click(25, 25)
        command(action="text", text=" whole app ")
        until(lambda: ("/api/value", {"text": [" whole app "]}) in received)
        click(35, 88)
        chooser = until(lambda: sessions.rpc(identifier, "operator", "status").get("chooser"))
        transfer = sessions.begin_upload(
            identifier,
            "operator",
            GuiUploadRequest(
                chooser_id=chooser["chooser_id"],
                files=[{"relative_path": "folder/motion.txt", "size_bytes": 3}],
            ),
        )
        with pytest.raises(RuntimeServiceError):
            sessions.put_upload(
                identifier, "operator", transfer["upload_id"], "../escape", 0, b"bad"
            )
        sessions.put_upload(
            identifier, "operator", transfer["upload_id"], "folder/motion.txt", 0, b"abc"
        )
        sessions.finish_upload(identifier, "operator", transfer["upload_id"])
        until(lambda: ("/api/uploaded", {"name": ["motion.txt"]}) in received)
        click(40, 146)
        downloads = until(lambda: sessions.rpc(identifier, "operator", "status")["downloads"])
        path, name = sessions.download(identifier, "operator", downloads[0]["download_id"])
        assert name == "hello.txt"
        assert path.read_bytes() == b"GUI transfer bytes"
        snapshot = sessions.rpc(identifier, "operator", "snapshot", frame=0)
        pixels = np.asarray(Image.open(io.BytesIO(snapshot["payload"])))
        assert pixels.shape[:2] == (480, 640)
        assert pixels.std() > 5
        unfinished = sessions.begin_upload(
            identifier,
            "operator",
            GuiUploadRequest(
                chooser_id="drop", files=[{"relative_path": "unfinished.txt", "size_bytes": 1}]
            ),
        )
        sessions.close(identifier, "operator")
        with pytest.raises(RuntimeServiceError, match="closed"):
            sessions.put_upload(
                identifier, "operator", unfinished["upload_id"], "unfinished.txt", 0, b"x"
            )
        assert identifier not in control._session_tokens
        assert not path.exists()
    finally:
        sessions.shutdown()
        server.shutdown()
        server.server_close()
        thread.join(2)
