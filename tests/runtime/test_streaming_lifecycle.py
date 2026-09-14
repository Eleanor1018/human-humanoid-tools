"""Regression coverage for GUI authorization, failed RPCs and abandoned connections."""

import asyncio
import socket
import threading
import time

import httpx
import pytest
import uvicorn

from hhtools.application.gui_sessions import GuiSessions
from hhtools.application.process_executor import _receive, _send
from hhtools.application.runtime import ApplicationPaths
from hhtools.contracts.gui import GuiSessionRequest
from hhtools.contracts.runtime import RuntimeTokenRequest
from hhtools.runtime.server import create_runtime_app
from hhtools.services.runtime_control import RuntimeControl, RuntimeServiceError

API = "/api/runtime/v1/gui-sessions"


def slow_worker(connection):
    _send(connection, {"frame_count": 1, "duration_seconds": 0})
    while True:
        request = _receive(connection)
        if request["operation"] == "close":
            break
        time.sleep(0.2)
        _send(connection, {"type": "answer", "sdp": "late-answer"})
    connection.close()


@pytest.fixture
def leased_gui(tmp_path, monkeypatch):
    control = RuntimeControl(tmp_path / "control")
    sessions = GuiSessions(ApplicationPaths.isolated(tmp_path), control)
    sessions.origin = "http://127.0.0.1:8000"
    monkeypatch.setattr(sessions, "capabilities", lambda: {"webrtc": {"available": True}})

    def worker(spawn, child, request, directory, *, token_id=None):
        control.issue_session_token(directory.name, token_id=token_id)
        return spawn.Process(target=slow_worker, args=(child,))

    monkeypatch.setattr(sessions, "_worker", worker)
    yield sessions, control
    sessions.shutdown()


@pytest.mark.parametrize("failure", ["timeout", "disconnect"])
def test_failed_rpc_closes_worker_and_delegated_credential(leased_gui, monkeypatch, failure):
    sessions, control = leased_gui
    created = sessions.create(GuiSessionRequest(), "operator")
    identifier = created["session_id"]
    session = sessions._sessions[identifier]
    pipe = session["connection"]
    if failure == "timeout":
        poll = pipe.poll
        monkeypatch.setattr(pipe, "poll", lambda _: poll(0.01))
    else:
        pipe.close()
    with pytest.raises(RuntimeServiceError, match="PREVIEW_TIMEOUT|PREVIEW_DISCONNECTED"):
        sessions.rpc(identifier, "operator", "offer", sdp="offer")
    assert session["state"] == "closed"
    assert session["reason"] == (
        "backend_timeout" if failure == "timeout" else "backend_disconnected"
    )
    assert identifier not in control._session_tokens
    assert not session["directory"].exists()
    with pytest.raises(ValueError, match="closed"):
        session["process"].is_alive()
    with pytest.raises(RuntimeServiceError, match="PREVIEW_CLOSED"):
        sessions.rpc(identifier, "operator", "status")
    replacement = sessions.create(GuiSessionRequest(), "operator")
    assert replacement["session_id"] != identifier


def test_revocation_is_bound_to_the_creating_token(leased_gui):
    sessions, control = leased_gui
    operator = control.issue_token(RuntimeTokenRequest(subject="operator", scopes=["admin"]))
    other = control.issue_token(RuntimeTokenRequest(subject="operator", scopes=["admin"]))
    identifier = sessions.create(GuiSessionRequest(), "operator", token_id=operator.token_id)[
        "session_id"
    ]
    assert (
        sessions.create(GuiSessionRequest(), "operator", token_id=operator.token_id)["session_id"]
        == identifier
    )
    with pytest.raises(RuntimeServiceError, match="GUI_SESSION_IN_USE"):
        sessions.create(GuiSessionRequest(), "operator", token_id=other.token_id)
    control.revoke_token(other.token_id)
    assert sessions.get(identifier, "operator")["state"] == "ready"
    control.revoke_token(operator.token_id)
    assert sessions.get(identifier, "operator")["reason"] == "token_revoked"
    assert identifier not in control._session_tokens
    with pytest.raises(RuntimeServiceError, match="UNAUTHORIZED"):
        sessions.create(GuiSessionRequest(), "operator", token_id=operator.token_id)
    assert not control._session_tokens


def test_revocation_during_worker_start_does_not_leave_an_orphan(leased_gui, monkeypatch):
    sessions, control = leased_gui
    operator = control.issue_token(RuntimeTokenRequest(subject="operator", scopes=["admin"]))
    worker = sessions._worker
    created = threading.Event()
    revoked = threading.Event()
    outcome = []

    def paused_worker(*args, **kwargs):
        process = worker(*args, **kwargs)
        created.set()
        assert revoked.wait(5)
        return process

    def revoke():
        assert created.wait(5)
        control.revoke_token(operator.token_id)

    # The first listener signals that persistent and delegated credentials are gone.
    def revocation_listener(token_id):
        revoked.set()
        sessions._operator_revoked(token_id)

    control.remove_token_revocation_listener(sessions._operator_revoked)
    control.add_token_revocation_listener(revocation_listener)
    monkeypatch.setattr(sessions, "_worker", paused_worker)
    thread = threading.Thread(target=revoke)
    thread.start()
    try:
        outcome.append(sessions.create(GuiSessionRequest(), "operator", token_id=operator.token_id))
    finally:
        thread.join(10)
        control.remove_token_revocation_listener(revocation_listener)
    assert not thread.is_alive()
    assert sessions.get(outcome[0]["session_id"], "operator")["state"] == "closed"
    assert not control._session_tokens


@pytest.fixture
def live_stream_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("HHTOOLS_ICE_SERVERS", "[]")
    app = create_runtime_app(ApplicationPaths.isolated(tmp_path))
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
    app.state.gui_sessions.origin = origin
    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        assert server.started
        yield app, origin
    finally:
        server.should_exit = True
        thread.join(15)
        listener.close()
        assert not thread.is_alive()


def test_revocation_closes_real_gui_datachannel(live_stream_runtime):
    aiortc = pytest.importorskip("aiortc")
    pytest.importorskip("playwright")
    app, origin = live_stream_runtime
    control = app.state.runtime_control
    operator = control.issue_token(RuntimeTokenRequest(subject="operator", scopes=["admin"]))

    async def scenario():
        peer = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=[]))
        async with httpx.AsyncClient(
            base_url=origin, headers={"Authorization": "Bearer " + operator.token}, timeout=50
        ) as client:
            created = await client.post(API, json={"width": 640, "height": 480})
            assert created.status_code == 200, created.text
            identifier = created.json()["session_id"]
            opened, closed = asyncio.Event(), asyncio.Event()
            channel = peer.createDataChannel("gui-input")
            channel.on("open", opened.set)
            channel.on("close", closed.set)
            peer.addTransceiver("video", direction="recvonly")
            try:
                await peer.setLocalDescription(await peer.createOffer())
                answer = await client.post(
                    f"{API}/{identifier}/offer",
                    json={"type": "offer", "sdp": peer.localDescription.sdp},
                )
                assert answer.status_code == 200, answer.text
                await peer.setRemoteDescription(aiortc.RTCSessionDescription(**answer.json()))
                await asyncio.wait_for(opened.wait(), 10)
                revoked = await client.delete("/api/runtime/v1/admin/tokens/" + operator.token_id)
                assert revoked.status_code == 200, revoked.text
                await asyncio.wait_for(closed.wait(), 10)
                assert channel.readyState == "closed"
                assert identifier not in control._session_tokens
                assert (
                    app.state.gui_sessions.get(identifier, "operator")["reason"] == "token_revoked"
                )
                assert (await client.post(f"{API}/{identifier}/renew")).status_code == 401
            finally:
                await peer.close()

    asyncio.run(scenario())


def test_aborted_creation_is_reclaimed_by_server(live_stream_runtime, monkeypatch):
    app, origin = live_stream_runtime
    sessions = app.state.gui_sessions
    started, resume, cleaned = threading.Event(), threading.Event(), threading.Event()
    closed = []

    def create(*args, **kwargs):
        started.set()
        assert resume.wait(10)
        return {"session_id": "abandoned"}

    def close(*args, **kwargs):
        closed.append((args, kwargs))
        cleaned.set()

    monkeypatch.setattr(sessions, "create", create)
    monkeypatch.setattr(sessions, "close", close)
    with socket.create_connection(("127.0.0.1", int(origin.rsplit(":", 1)[1]))) as client:
        client.sendall(
            (
                f"POST {API} HTTP/1.1\r\nHost: {origin[7:]}\r\n"
                "Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"
            ).encode()
        )
        assert started.wait(5)
        client.shutdown(socket.SHUT_RDWR)
    resume.set()
    assert cleaned.wait(5)
    assert closed == [(("abandoned", "local"), {"reason": "client_disconnected"})]


@pytest.fixture
def stream_page(live_stream_runtime):
    playwright = pytest.importorskip("playwright.sync_api")
    with playwright.sync_playwright() as runtime:
        browser = runtime.chromium.launch()
        page = browser.new_page()
        page.clock.install()
        yield page, live_stream_runtime[1]
        browser.close()


def mock_stream_routes(page, *, stall=None):
    calls = []
    pending = []

    def handle(route):
        path = route.request.url.split("/api/", 1)[1]
        method = route.request.method
        calls.append((method, path))
        if path.endswith("/identity"):
            result = {
                "runtime_id": "runtime:test",
                "workspace_id": "workspace:test",
                "mode": "local",
            }
        elif path.endswith("/capabilities"):
            result = {"webrtc": {"available": True}, "ice_servers": []}
        elif path.endswith("/gui-sessions") and method == "POST":
            result = {
                "session_id": "test",
                "state": "ready",
                "request": {"width": 640, "height": 480},
            }
        else:
            result = {"chooser": None, "downloads": []}
        if stall and path.endswith(stall):
            pending.append(route)
            return
        if path.endswith("/offer"):
            route.fulfill(status=503, json={"code": "OFFER_FAILED", "message": "Test failure"})
        else:
            route.fulfill(json=result)

    page.route("**/api/**", handle)
    return calls, pending


def test_failed_offer_releases_slot_and_allows_retry(stream_page):
    page, origin = stream_page
    calls, _ = mock_stream_routes(page)
    page.goto(origin + "/stream")
    for _ in range(2):
        page.get_by_role("button", name="Connect", exact=True).click()
        page.get_by_role("alert").filter(has_text="OFFER_FAILED").wait_for()
        assert page.get_by_role("button", name="Connect", exact=True).is_enabled()
    page.clock.fast_forward(65000)
    page.wait_for_timeout(100)
    assert sum(method == "DELETE" for method, _ in calls) == 2
    assert not any(path.endswith("/renew") for _, path in calls)
    assert not page.locator(".stream-surface").is_visible()


@pytest.mark.parametrize(
    "stage,timeout", [("/identity", 10000), ("/gui-sessions", 50000), ("/offer", 25000)]
)
def test_stalled_handshake_times_out_and_can_be_retried(stream_page, stage, timeout):
    page, origin = stream_page
    calls, pending = mock_stream_routes(page, stall=stage)
    page.goto(origin + "/stream")
    page.get_by_role("button", name="Connect", exact=True).click()
    deadline = time.monotonic() + 10
    while not pending and time.monotonic() < deadline:
        page.wait_for_timeout(50)
    assert pending
    page.clock.fast_forward(timeout + 1)
    page.get_by_role("alert").filter(has_text="timed out").wait_for()
    assert page.get_by_role("button", name="Connect", exact=True).is_enabled()
    page.clock.fast_forward(65000)
    page.wait_for_timeout(100)
    assert not any(path.endswith("/renew") for _, path in calls)
    assert sum(method == "DELETE" for method, _ in calls) == (1 if stage == "/offer" else 0)


@pytest.mark.parametrize("stage", ["/identity", "/offer"])
def test_cancelling_handshake_returns_to_connection_form(stream_page, stage):
    page, origin = stream_page
    calls, pending = mock_stream_routes(page, stall=stage)
    page.goto(origin + "/stream")
    page.get_by_role("button", name="Connect", exact=True).click()
    deadline = time.monotonic() + 10
    while not pending and time.monotonic() < deadline:
        page.wait_for_timeout(50)
    assert pending
    if stage == "/offer":
        with page.expect_response(lambda response: response.request.method == "DELETE"):
            page.get_by_role("button", name="Close session", exact=True).click()
    else:
        page.get_by_role("button", name="Cancel", exact=True).click()
    assert page.get_by_role("button", name="Connect", exact=True).is_enabled()
    page.clock.fast_forward(130000)
    page.wait_for_timeout(100)
    assert page.get_by_role("alert").count() == 0
    assert not any(path.endswith("/renew") for _, path in calls)
    assert sum(method == "DELETE" for method, _ in calls) == (1 if stage == "/offer" else 0)


def test_browser_connects_and_closes_real_stream(stream_page):
    page, origin = stream_page
    page.goto(origin + "/stream")
    page.get_by_role("button", name="Connect", exact=True).click()
    page.locator('.stream-state[data-connected="true"]').wait_for(timeout=60000)
    page.wait_for_function("document.querySelector('video').videoWidth > 0")
    assert page.locator(".stream-surface").is_visible()
    session = httpx.get(origin + API).json()[-1]["session_id"]
    with page.expect_response(lambda response: response.url.endswith("/offer")):
        page.get_by_role("button", name="Reconnect", exact=True).click()
    page.locator('.stream-state[data-connected="true"]').wait_for(timeout=60000)
    assert httpx.get(origin + API).json()[-1]["session_id"] == session
    page.get_by_role("button", name="Close session", exact=True).click()
    assert page.get_by_role("button", name="Connect", exact=True).is_enabled()
    page.get_by_role("button", name="Connect", exact=True).click()
    page.locator('.stream-state[data-connected="true"]').wait_for(timeout=60000)
    page.get_by_role("button", name="Close session", exact=True).click()
