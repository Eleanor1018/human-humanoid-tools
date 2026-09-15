"""Authenticated preview session lifecycle and one-time WebRTC signaling."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, Response

from hhtools.application.preview_sessions import PreviewSessions
from hhtools.contracts.previews import (
    PreviewAnswer,
    PreviewCreateRequest,
    PreviewInput,
    PreviewOffer,
    PreviewSession,
)

from .boundary import PREFIX


def install_previews(app, runtime, control):
    sessions = PreviewSessions(runtime.paths, control)
    app.state.preview_sessions = sessions
    router = APIRouter(prefix=PREFIX, tags=["previews"])
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with original_lifespan(application):
            try:
                yield
            finally:
                sessions.shutdown()

    app.router.lifespan_context = lifespan

    def subject(request):
        return request.state.runtime_principal["subject"]

    @router.get("/preview-capabilities")
    def runtime_preview_capabilities() -> dict:
        return sessions.capabilities()

    @router.post("/previews", response_model=PreviewSession)
    def runtime_create_preview(request: Request, body: PreviewCreateRequest) -> dict:
        if body.source.asset_id:
            runtime.services.runtime_asset_policy.require(body.source.asset_id)
        return sessions.create(body, subject(request))

    @router.get("/previews", response_model=list[PreviewSession])
    def runtime_list_previews(request: Request):
        return sessions.list(subject(request))

    @router.get("/previews/{session_id}", response_model=PreviewSession)
    def runtime_get_preview(request: Request, session_id: str) -> dict:
        return sessions.get(session_id, subject(request))

    @router.post("/previews/{session_id}/renew", response_model=PreviewSession)
    def runtime_renew_preview(request: Request, session_id: str) -> dict:
        return sessions.renew(session_id, subject(request))

    @router.delete("/previews/{session_id}", response_model=PreviewSession)
    def runtime_close_preview(request: Request, session_id: str) -> dict:
        return sessions.close(session_id, subject(request))

    @router.post("/previews/{session_id}/offer", response_model=PreviewAnswer)
    def runtime_preview_offer(request: Request, session_id: str, body: PreviewOffer) -> dict:
        return sessions.rpc(session_id, subject(request), "offer", sdp=body.sdp)

    @router.post("/previews/{session_id}/input")
    def runtime_preview_input(request: Request, session_id: str, body: PreviewInput) -> dict:
        return sessions.rpc(
            session_id, subject(request), "input", input=body.model_dump(mode="json")
        )

    @router.get("/previews/{session_id}/data", include_in_schema=False)
    def runtime_preview_data(request: Request, session_id: str):
        return FileResponse(
            sessions.data_path(session_id, subject(request)), media_type="application/json"
        )

    @router.get("/previews/{session_id}/snapshot", include_in_schema=False)
    def runtime_preview_snapshot(
        request: Request, session_id: str, frame: int = Query(default=0, ge=0)
    ):
        snapshot = sessions.rpc(session_id, subject(request), "snapshot", frame=frame)
        return Response(snapshot["payload"], media_type="image/png")

    app.include_router(router)
