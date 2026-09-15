"""Authenticated signaling and transfers for a whole HHTools GUI session."""

import json
import os
from contextlib import asynccontextmanager

import anyio
from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, Response
from starlette.concurrency import run_in_threadpool

from hhtools.application.gui_sessions import GuiSessions
from hhtools.contracts.gui import GuiInput, GuiSessionRequest, GuiUploadRequest
from hhtools.contracts.previews import PreviewOffer

from .boundary import PREFIX


def install_streaming(app, runtime, control):
    sessions = GuiSessions(runtime.paths, control)
    app.state.gui_sessions = sessions
    router = APIRouter(prefix=PREFIX + "/gui-sessions", tags=["GUI transport"])
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with original(application):
            try:
                yield
            finally:
                sessions.shutdown()

    app.router.lifespan_context = lifespan

    def subject(request):
        return request.state.runtime_principal["subject"]

    @router.get("/capabilities")
    def capabilities():
        return {
            **sessions.capabilities(),
            "ice_servers": json.loads(os.environ.get("HHTOOLS_ICE_SERVERS", "[]")),
        }

    @router.post("")
    async def create(request: Request, body: GuiSessionRequest):
        created = await run_in_threadpool(
            sessions.create,
            body,
            subject(request),
            token_id=request.state.runtime_principal.get("token_id"),
        )
        disconnected = False
        # Unlike is_disconnected(), allow middleware receive checkpoints to run.
        # The request body has already been consumed by FastAPI.
        with anyio.move_on_after(0.05):
            disconnected = (await request.receive())["type"] == "http.disconnect"
        if disconnected:
            await run_in_threadpool(
                sessions.close,
                created["session_id"],
                subject(request),
                reason="client_disconnected",
            )
        return created

    @router.get("")
    def listing(request: Request):
        return sessions.list(subject(request))

    @router.get("/{session_id}")
    def status(request: Request, session_id: str):
        return {
            **sessions.get(session_id, subject(request)),
            **sessions.rpc(session_id, subject(request), "status"),
        }

    @router.post("/{session_id}/renew")
    def renew(request: Request, session_id: str):
        return sessions.renew(session_id, subject(request))

    @router.delete("/{session_id}")
    def close(request: Request, session_id: str):
        return sessions.close(session_id, subject(request))

    @router.post("/{session_id}/offer")
    def offer(request: Request, session_id: str, body: PreviewOffer):
        return sessions.rpc(session_id, subject(request), "offer", sdp=body.sdp)

    @router.post("/{session_id}/input")
    def input_event(request: Request, session_id: str, body: GuiInput):
        return sessions.rpc(
            session_id, subject(request), "input", input=body.model_dump(mode="json")
        )

    @router.get("/{session_id}/snapshot")
    def snapshot(request: Request, session_id: str):
        result = sessions.rpc(session_id, subject(request), "snapshot", frame=0)
        return Response(result["payload"], media_type="image/png")

    @router.post("/{session_id}/uploads")
    def begin_upload(request: Request, session_id: str, body: GuiUploadRequest):
        return sessions.begin_upload(session_id, subject(request), body)

    @router.put("/{session_id}/uploads/{upload_id}/content")
    async def content(
        request: Request, session_id: str, upload_id: str, member: str, offset: int = Query(ge=0)
    ):
        return sessions.put_upload(
            session_id, subject(request), upload_id, member, offset, await request.body()
        )

    @router.post("/{session_id}/uploads/{upload_id}/complete")
    def complete_upload(request: Request, session_id: str, upload_id: str):
        return sessions.finish_upload(session_id, subject(request), upload_id)

    @router.get("/{session_id}/downloads/{download_id}")
    def download(request: Request, session_id: str, download_id: str):
        path, name = sessions.download(session_id, subject(request), download_id)
        return FileResponse(path, filename=name)

    app.include_router(router)
