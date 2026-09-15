"""Leased whole-application sessions with operator-scoped file transfers."""

from __future__ import annotations

import importlib.util
import os
import signal
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from hhtools.application.gui_worker import run_gui_worker
from hhtools.application.preview_sessions import PreviewSessions
from hhtools.services.runtime_control import RuntimeServiceError


class GuiSessions(PreviewSessions):
    namespace = "gui-sessions"
    origin = None

    def __init__(self, paths, control):
        super().__init__(paths, control)
        control.add_token_revocation_listener(self._operator_revoked)

    def _operator_revoked(self, token_id):
        with self._lock:
            for session in self._sessions.values():
                if session.get("token_id") == token_id:
                    self.close(session["session_id"], session["subject"], reason="token_revoked")

    def shutdown(self):
        super().shutdown()
        self.control.remove_token_revocation_listener(self._operator_revoked)

    @staticmethod
    def capabilities():
        available = all(
            importlib.util.find_spec(name) is not None for name in ("playwright", "aiortc", "av")
        )
        return {
            "webrtc": {
                "available": available,
                "backend": "chromium",
                "encoder": "aiortc",
                "application": "hhtools-gui",
                "reason": None
                if available
                else "Install hhtools[streaming] and run playwright install chromium.",
            }
        }

    def create(self, request, subject, *, token_id=None):
        if not self.origin:
            raise RuntimeServiceError(
                "GUI_ORIGIN_UNAVAILABLE",
                "Configure the Runtime's own GUI origin before starting a session.",
            )
        parsed = urlsplit(self.origin)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
            or parsed.username
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise RuntimeServiceError(
                "GUI_ORIGIN_FORBIDDEN",
                "The GUI process must connect to this Runtime over loopback.",
            )
        with self._lock:
            for session in self._sessions.values():
                with session["lock"]:
                    if session["state"] != "ready":
                        continue
                    if (
                        session["expires_at"] <= datetime.now(UTC)
                        or not session["process"].is_alive()
                    ):
                        self._close(session, reason="expired")
                        continue
                    if session["subject"] == subject and session.get("token_id") == token_id:
                        return self._view(session)
                    raise RuntimeServiceError(
                        "GUI_SESSION_IN_USE",
                        "The application's control session belongs to another operator.",
                    )
            created = super().create(request, subject, token_id=token_id)
            self._sessions[created["session_id"]]["token_id"] = token_id
            return created

    def _worker(self, spawn, child, request, directory, *, token_id=None):
        token = self.control.issue_session_token(directory.name, token_id=token_id)
        return spawn.Process(
            target=run_gui_worker,
            args=(child, self.origin, token, request.model_dump(mode="json"), directory),
        )

    def _released(self, session_id):
        self.control.revoke_session_token(session_id)

    def _stop_worker(self, process):
        pid = process.pid
        super()._stop_worker(process)
        # Chromium descendants must not outlive a failed or forcibly stopped worker.
        if os.name == "posix" and pid is not None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def begin_upload(self, session_id, subject, request):
        session = self._session(session_id, subject)
        status = self.rpc(session_id, subject, "status")
        if request.chooser_id != "drop" and (
            not status.get("chooser") or status["chooser"]["chooser_id"] != request.chooser_id
        ):
            raise RuntimeServiceError(
                "GUI_CHOOSER_EXPIRED", "Open the application's file picker again."
            )
        with session["lock"]:
            if session["state"] != "ready":
                raise RuntimeServiceError("GUI_CLOSED", "The GUI session is closed.")
            size = sum(item.size_bytes for item in request.files)
            names = [item.relative_path for item in request.files]
            names.sort()
            if len(names) != len(set(names)) or any(
                a.startswith(b + "/") for b, a in zip(names, names[1:], strict=False)
            ):
                raise RuntimeServiceError("INVALID_UPLOAD", "Upload members must be unique files.")
            transfers = session.setdefault("transfers", {})
            if (
                len(transfers) >= 32
                or size + sum(item["size"] for item in transfers.values()) > 4 * 1024**3
            ):
                raise RuntimeServiceError(
                    "UPLOAD_BUDGET_EXCEEDED", "The GUI session file-transfer budget is exhausted."
                )
            transfer_id = uuid.uuid4().hex
            root = session["directory"] / "uploads" / transfer_id
            root.mkdir(parents=True)
            transfers[transfer_id] = {
                "size": size,
                "root": root,
                "request": request,
                "complete": False,
            }
            return {"upload_id": transfer_id, "chunk_bytes": 8 * 1024**2}

    def _transfer(self, session, upload_id):
        if session["state"] != "ready":
            raise RuntimeServiceError("GUI_CLOSED", "The GUI session is closed.")
        transfer = session.get("transfers", {}).get(upload_id)
        if transfer is None or transfer["complete"]:
            raise RuntimeServiceError("UPLOAD_NOT_FOUND", "The GUI file transfer is unavailable.")
        return transfer

    def put_upload(self, session_id, subject, upload_id, member, offset, payload):
        session = self._session(session_id, subject)
        with session["lock"]:
            transfer = self._transfer(session, upload_id)
            spec = next(
                (item for item in transfer["request"].files if item.relative_path == member), None
            )
            if spec is None:
                raise RuntimeServiceError(
                    "UPLOAD_MEMBER_NOT_FOUND", "Member is not in the transfer manifest."
                )
            path = transfer["root"] / spec.relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            if (
                offset != (path.stat().st_size if path.exists() else 0)
                or offset + len(payload) > spec.size_bytes
            ):
                raise RuntimeServiceError(
                    "INVALID_RANGE", "Upload offset or length does not match the manifest."
                )
            with path.open("ab") as stream:
                stream.write(payload)
            return {"offset": path.stat().st_size}

    def finish_upload(self, session_id, subject, upload_id):
        session = self._session(session_id, subject)
        with session["lock"]:
            transfer = self._transfer(session, upload_id)
            files = []
            for member in transfer["request"].files:
                path = transfer["root"] / member.relative_path
                if not path.is_file() or path.stat().st_size != member.size_bytes:
                    raise RuntimeServiceError(
                        "UPLOAD_INCOMPLETE", "Not all files have been transferred."
                    )
                files.append(str(path))
            chooser_id = transfer["request"].chooser_id
        result = self.rpc(
            session_id,
            subject,
            "drop" if chooser_id == "drop" else "files",
            chooser_id=chooser_id,
            files=files,
            root=str(transfer["root"]),
            x=transfer["request"].x,
            y=transfer["request"].y,
        )
        with session["lock"]:
            transfer["complete"] = True
        return result

    def download(self, session_id, subject, download_id):
        info = self.rpc(session_id, subject, "download", download_id=download_id)
        root = self._session(session_id, subject)["directory"]
        return root / "downloads" / info["download_id"], Path(info["filename"]).name

    def _view(self, session):
        view = super()._view(session)
        view.pop("transfers", None)
        view.pop("token_id", None)
        return view
