"""Bounded preview leases, independent of durable job and Runtime lifetimes."""

from __future__ import annotations

import importlib.util
import multiprocessing
import shutil
import threading
import uuid
from datetime import UTC, datetime, timedelta

from hhtools.application.preview_worker import run_preview_worker
from hhtools.application.process_executor import SupervisedExecutor, _receive, _send
from hhtools.contracts.previews import PreviewCreateRequest
from hhtools.services.runtime_control import RuntimeServiceError


class PreviewSessions:
    def __init__(self, paths, control):
        self.paths = paths
        self.control = control
        self._lock = threading.RLock()
        self._sessions = {}
        self._closed = threading.Event()
        self._sweeper = threading.Thread(
            target=self._expire, name="hhtools-preview-leases", daemon=True
        )
        self._sweeper.start()

    @staticmethod
    def capabilities():
        media = all(
            importlib.util.find_spec(name) is not None for name in ("aiortc", "mujoco", "av")
        )
        return {
            "data": {"available": True, "render_location": "client"},
            "webrtc": {
                "available": media,
                "render_location": "server",
                "max_connections_per_session": 1,
                "backend": "mujoco",
                "encoder": "aiortc",
                "checkpoint_resume": False,
                "reason": None if media else "Install hhtools[preview] on the Runtime host.",
                "network": "Direct ICE candidates; configure HHTOOLS_ICE_SERVERS for STUN/TURN.",
            },
        }

    def create(self, request: PreviewCreateRequest, subject: str):
        if request.mode == "webrtc" and not self.capabilities()["webrtc"]["available"]:
            raise RuntimeServiceError(
                "PREVIEW_BACKEND_UNAVAILABLE", "Install the optional preview backend."
            )
        with self._lock:
            active = sum(item["state"] == "ready" for item in self._sessions.values())
            if active >= self.control.budget.max_preview_sessions:
                raise RuntimeServiceError(
                    "PREVIEW_BUDGET_EXCEEDED", "All preview slots are occupied."
                )
            session_id = uuid.uuid4().hex
            directory = self.control.data_dir / "previews" / session_id
            directory.mkdir(parents=True)
            spawn = multiprocessing.get_context("spawn")
            parent, child = spawn.Pipe()
            process = spawn.Process(
                target=run_preview_worker,
                args=(child, self.paths, request.model_dump(mode="json"), directory),
            )
            process.start()
            child.close()
            try:
                if not parent.poll(45):
                    raise RuntimeServiceError(
                        "PREVIEW_START_TIMEOUT", "Preview initialization timed out."
                    )
                ready = _receive(parent)
                if ready.get("error"):
                    raise RuntimeServiceError(
                        ready["error"],
                        "Preview backend could not open this resource.",
                        exception_type=ready.get("exception_type"),
                    )
                session = {
                    "session_id": session_id,
                    "subject": subject,
                    "request": request.model_dump(mode="json"),
                    "state": "ready",
                    "reason": None,
                    "frame_count": ready["frame_count"],
                    "duration_seconds": ready["duration_seconds"],
                    "expires_at": datetime.now(UTC) + timedelta(seconds=request.ttl_seconds),
                    "process": process,
                    "connection": parent,
                    "directory": directory,
                    "lock": threading.Lock(),
                }
                self._sessions[session_id] = session
                return self._view(session)
            except BaseException:
                SupervisedExecutor._stop(process)
                parent.close()
                process.close()
                shutil.rmtree(directory, ignore_errors=True)
                raise

    def _session(self, session_id, subject):
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise RuntimeServiceError("PREVIEW_NOT_FOUND", "Preview session was not found.")
            if session["subject"] != subject:
                raise RuntimeServiceError(
                    "PREVIEW_FORBIDDEN", "Preview belongs to another principal."
                )
            return session

    def _view(self, session):
        return {
            key: value.isoformat() if isinstance(value, datetime) else value
            for key, value in session.items()
            if key not in {"process", "connection", "directory", "lock", "subject"}
        }

    def get(self, session_id, subject):
        session = self._session(session_id, subject)
        return self._view(session)

    def list(self, subject):
        with self._lock:
            return [
                self._view(item) for item in self._sessions.values() if item["subject"] == subject
            ]

    def rpc(self, session_id, subject, operation, **arguments):
        session = self._session(session_id, subject)
        with session["lock"]:
            if session["state"] != "ready":
                raise RuntimeServiceError("PREVIEW_CLOSED", "Preview is closed or expired.")
            if (
                operation == "snapshot"
                and not 0 <= arguments.get("frame", 0) < session["frame_count"]
            ):
                raise RuntimeServiceError("INVALID_FRAME", "Frame is outside the preview timeline.")
            try:
                _send(session["connection"], {"operation": operation, **arguments})
                if not session["connection"].poll(20):
                    raise RuntimeServiceError("PREVIEW_TIMEOUT", "Preview backend did not respond.")
                response = _receive(session["connection"])
                if response.get("error"):
                    raise RuntimeServiceError(response["error"], "Preview operation failed.")
                if operation == "snapshot":
                    response["payload"] = (session["directory"] / "snapshot.png").read_bytes()
                return response
            except (OSError, EOFError) as error:
                raise RuntimeServiceError(
                    "PREVIEW_DISCONNECTED", "Preview backend disconnected."
                ) from error

    def renew(self, session_id, subject):
        self.rpc(session_id, subject, "renew")
        session = self._session(session_id, subject)
        session["expires_at"] = datetime.now(UTC) + timedelta(
            seconds=session["request"]["ttl_seconds"]
        )
        return self._view(session)

    def data_path(self, session_id, subject, name="scene.json"):
        session = self._session(session_id, subject)
        if session["state"] != "ready":
            raise RuntimeServiceError("PREVIEW_CLOSED", "Preview is closed or expired.")
        return session["directory"] / name

    def close(self, session_id, subject, *, reason="closed"):
        session = self._session(session_id, subject)
        with session["lock"]:
            if session["state"] != "ready":
                return self._view(session)
            try:
                _send(session["connection"], {"operation": "close"})
                session["process"].join(2)
            except (OSError, EOFError):
                pass
            SupervisedExecutor._stop(session["process"])
            session["connection"].close()
            session["process"].close()
            session["state"] = "expired" if reason == "expired" else "closed"
            session["reason"] = reason
            shutil.rmtree(session["directory"], ignore_errors=True)
            return self._view(session)

    def _expire(self):
        while not self._closed.wait(1):
            with self._lock:
                sessions = list(self._sessions.values())
            for session in sessions:
                if session["state"] == "ready":
                    expired = session["expires_at"] <= datetime.now(UTC)
                    exited = not session["process"].is_alive()
                    if expired or exited:
                        self.close(
                            session["session_id"],
                            session["subject"],
                            reason="expired" if expired else "backend_exited",
                        )
            with self._lock:
                closed = [key for key, item in self._sessions.items() if item["state"] != "ready"]
                for key in closed[:-100]:
                    del self._sessions[key]

    def shutdown(self):
        self._closed.set()
        self._sweeper.join(2)
        for session in list(self._sessions.values()):
            self.close(session["session_id"], session["subject"], reason="runtime_stopped")
