"""Default commands, legacy run aliases, and durable workflow CLI recovery."""

import json
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from click.testing import CliRunner
from typer.main import get_command

from hhtools.cli import workflows
from hhtools.client.runtime import client_error

ASSET = "asset:sha256:" + "a" * 64
PLAN = "plan:sha256:" + "b" * 64


@pytest.mark.parametrize(
    "module,subcommand,args",
    [
        ("convert", None, ["motion.npz", "--out", "out"]),
        ("dataset", None, ["--dataset", "amass", "--root", "in", "--out", "out"]),
        ("retarget", None, ["motion.npz", "--robot", "g1", "--output", "out"]),
        ("retarget", "interaction-mesh", ["motion.npz", "--robot", "g1", "--output", "out"]),
    ],
)
def test_legacy_and_default_spelling_pass_identical_parameters(module, subcommand, args):
    import importlib

    app = get_command(importlib.import_module("hhtools.cli." + module).app)
    group = app.commands[subcommand] if subcommand else app
    calls = []
    group.commands["run"].callback = lambda **kwargs: calls.append(kwargs)
    prefix = [subcommand] if subcommand else []
    runner = CliRunner()
    direct = runner.invoke(app, [*prefix, *args])
    legacy = runner.invoke(app, [*prefix, "run", *args])
    assert direct.exit_code == legacy.exit_code == 0, (direct.output, legacy.output)
    assert len(calls) == 2 and calls[0] == calls[1]
    assert "run" not in str(calls[0])


def test_named_subcommands_and_double_dash_are_preserved():
    from hhtools.cli import dataset, retarget

    runner = CliRunner()
    app = get_command(dataset.app)
    app.commands["list"].callback = lambda: print("adapters")
    assert runner.invoke(app, ["list"]).output.strip() == "adapters"
    app = get_command(retarget.app)
    assert runner.invoke(app, ["interaction-mesh", "precompute-laplacian", "--help"]).exit_code == 0
    calls = []
    app.commands["run"].callback = lambda **kwargs: calls.append(kwargs)
    result = runner.invoke(app, ["--robot", "g1", "-o", "out", "--", "run"])
    assert result.exit_code == 0, result.output
    assert calls[0]["inputs"] == ("run",)


class FakeRuntime:
    endpoint = "http://localhost:9999"
    runtime_id = "runtime:test"
    workspace_id = "workspace:test"

    def __init__(self):
        self.calls = []
        self.job = {"job_id": "job:test", "state": "queued", "progress": {"revision": 1}}
        self.submitted = False
        self.lose_start_response = False
        self.rejection = None

    def connect(self):
        return {"runtime_id": self.runtime_id, "workspace_id": self.workspace_id}

    def upload(self, path, **kwargs):
        self.calls.append(("upload", kwargs))
        return {"asset_id": ASSET}

    def call(self, name, args=None):
        self.calls.append((name, args))
        if "preflight" in name:
            if self.rejection:
                return self.rejection
            return {"status": "ready", "plan": {"plan_id": PLAN}}
        if name == "hhtools_runtime_lookup_job":
            if not self.submitted:
                raise client_error("JOB_NOT_FOUND", "Not found")
            return self.job
        if name == "hhtools_runtime_start_job":
            self.submitted = True
            if self.lose_start_response:
                raise client_error("RUNTIME_UNAVAILABLE", "Start response lost", retryable=True)
            return self.job
        if name == "hhtools_runtime_wait_job":
            self.job = {**self.job, "state": "completed", "outcome": "success"}
        return self.job


@pytest.fixture
def runtime(monkeypatch):
    client = FakeRuntime()
    monkeypatch.setattr(workflows, "connect_or_start", lambda *a, **kw: client)
    monkeypatch.setattr(workflows, "RuntimeClient", lambda *a, **kw: client)
    return client


@pytest.mark.parametrize(
    "workflow,options",
    [
        ("h2r", ["--robot", "g1", "--mode", "smoke"]),
        ("r2r", ["--source-robot", "g1", "--target-robot", "rp1", "--source-fps", "120"]),
        ("analysis", ["--embedding", "handcrafted"]),
        ("video2motion", ["--moving-camera", "--focal-length-mm", "35"]),
    ],
)
def test_named_workflows_and_run_aliases_use_same_preflight(
    runtime, tmp_path, capsys, workflow, options
):
    for index, prefix in enumerate(([], ["run"])):
        receipt = tmp_path / f"run-{index}.json"
        result = workflows.run(workflow, [*prefix, ASSET, *options, "--receipt", str(receipt)])
        document = json.loads(capsys.readouterr().out)
        assert result == 0, document
        assert document["job"]["state"] == "completed"
        assert json.loads(receipt.read_text())["job_id"] == "job:test"
    requests = [args for name, args in runtime.calls if "preflight" in name]
    assert requests[0] == requests[1]
    assert not any(name == "upload" for name, _ in runtime.calls)


def test_lost_submission_response_recovers_original_job(runtime, tmp_path, capsys):
    path = tmp_path / "receipt.json"
    runtime.lose_start_response = True
    assert workflows.run("analysis", [ASSET, "--receipt", str(path), "--no-wait"]) == 2
    failure = json.loads(capsys.readouterr().out)
    assert failure["details"]["receipt"] == str(path)
    saved = json.loads(path.read_text())
    assert saved["plan_id"] == PLAN and saved["idempotency_key"]
    assert "token" not in saved
    assert workflows.run("analysis", ["--resume", str(path)]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["job"]["job_id"] == "job:test"
    assert sum(name == "hhtools_runtime_start_job" for name, _ in runtime.calls) == 1
    assert sum("preflight" in name for name, _ in runtime.calls) == 1


def test_nonready_plan_never_submits(runtime, tmp_path, capsys):
    runtime.rejection = {
        "status": "human_action_required",
        "required_actions": [
            {"actor": "human", "action": "install_backend"},
        ],
    }
    assert (
        workflows.run(
            "r2r",
            [
                ASSET,
                "--source-robot",
                "g1",
                "--target-robot",
                "rp1",
                "--receipt",
                str(tmp_path / "receipt.json"),
            ],
        )
        == 3
    )
    assert json.loads(capsys.readouterr().out)["preflight"] == runtime.rejection
    assert not runtime.submitted


def test_preflight_registers_the_exact_server_provided_robot_bundle(runtime, tmp_path, capsys):
    original = runtime.call
    robot_asset = "asset:sha256:" + "c" * 64
    registration = {"root_id": "robots", "relative_path": "g1", "kind": "robot_bundle"}

    def call(name, args=None):
        if name == "hhtools_preflight_retarget" and not args["request"].get("robot_asset_id"):
            return {
                "status": "rejected",
                "error": {
                    "code": "ROBOT_ASSET_REQUIRED",
                    "details": {"robot_id": "g1"},
                    "next_action": {
                        "actor": "agent",
                        "action": "register_asset_bundle",
                        "parameters": {"request": registration},
                    },
                },
            }
        if name == "hhtools_register_asset":
            assert args["request"]["root_id"] == "robots"
            assert args["request"]["relative_path"] == "g1"
            return {"asset_id": robot_asset}
        return original(name, args)

    runtime.call = call
    assert (
        workflows.run("h2r", [ASSET, "--robot", "g1", "--receipt", str(tmp_path / "receipt.json")])
        == 0
    )
    assert json.loads(capsys.readouterr().out)["job"]["state"] == "completed"
    request = next(args["request"] for name, args in runtime.calls if "preflight" in name)
    assert request["robot_asset_id"] == robot_asset


def test_resume_rejects_a_different_runtime_identity(tmp_path, capsys, monkeypatch):
    from hhtools.client.runtime import RuntimeClient

    receipt = tmp_path / "receipt.json"
    workflows._save(
        receipt,
        {
            "version": 1,
            "workflow": "analysis",
            "endpoint": "http://localhost",
            "runtime_id": "saved",
            "workspace_id": "saved",
            "plan_id": PLAN,
            "idempotency_key": "original",
        },
    )
    monkeypatch.setattr(
        RuntimeClient,
        "request",
        lambda *a, **kw: {"runtime_id": "different", "workspace_id": "different"},
    )
    assert workflows.run("analysis", ["--resume", str(receipt)]) == 2
    assert json.loads(capsys.readouterr().out)["code"] == "RUNTIME_MISMATCH"


def test_receipt_cannot_be_overwritten_by_a_new_invocation(runtime, tmp_path, capsys):
    receipt = tmp_path / "receipt.json"
    receipt.write_text("previous submission")
    assert workflows.run("analysis", [ASSET, "--receipt", str(receipt)]) == 2
    assert json.loads(capsys.readouterr().out)["code"] == "OUTPUT_EXISTS"
    assert not runtime.calls
    assert receipt.read_text() == "previous submission"


@pytest.mark.parametrize(
    "args",
    [
        ["--bad-option"],
        [ASSET, "--wait-timeout", "nan"],
        [ASSET, "--resume", "receipt.json"],
        ["--resume", "receipt.json", "--embedding", "pae"],
    ],
)
def test_invalid_workflow_arguments_are_json_without_submission(runtime, capsys, args):
    assert workflows.run("analysis", args) == 2
    assert json.loads(capsys.readouterr().out)["code"] == "INVALID_PARAMETER"
    assert not runtime.calls


def test_actual_cli_analysis_upload_wait_download_and_resume(tmp_path, synthetic_terrain_motion):
    import numpy as np
    import uvicorn

    from hhtools.application.runtime import ApplicationPaths
    from hhtools.io.npz import save_npz
    from hhtools.runtime.server import create_runtime_app

    motion = synthetic_terrain_motion
    motion.terrain = None
    motion.meta = {}
    motion.positions = np.repeat(motion.positions, 30, axis=0)
    motion.quaternions = np.repeat(motion.quaternions, 30, axis=0)
    source = tmp_path / "motion.npz"
    save_npz(motion, source)
    app = create_runtime_app(ApplicationPaths.isolated(tmp_path / "runtime"))
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    endpoint = f"http://127.0.0.1:{listener.getsockname()[1]}"
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical"))
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    receipt = tmp_path / "receipt.json"
    command = [sys.executable, "-m", "hhtools.cli.main", "analysis"]
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        started = subprocess.run(
            [
                *command,
                str(source),
                "--endpoint",
                endpoint,
                "--receipt",
                str(receipt),
                "--output",
                str(tmp_path / "output"),
            ],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        assert started.returncode == 0, (started.stdout, started.stderr)
        result = json.loads(started.stdout)
        assert result["job"]["state"] == "completed"
        assert len(result["downloads"]) == 1
        report = json.loads(Path(result["downloads"][0]["path"]).read_text())
        assert len(report["clips"]) == 1
        resumed = subprocess.run(
            [*command, "run", "--resume", str(receipt)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        assert resumed.returncode == 0, (resumed.stdout, resumed.stderr)
        assert json.loads(resumed.stdout)["job"]["job_id"] == result["job"]["job_id"]

        def invoke(*args):
            process = subprocess.run(
                [sys.executable, "-m", "hhtools.cli.main", *args, "--endpoint", endpoint, "--json"],
                capture_output=True,
                text=True,
                timeout=45,
                check=False,
            )
            assert process.returncode == 0, (process.stdout, process.stderr)
            return json.loads(process.stdout)

        job_id = result["job"]["job_id"]
        artifact_id = result["downloads"][0]["artifact_id"]
        assert invoke("jobs", "list")["jobs"][0]["job_id"] == job_id
        assert invoke("runtime", "jobs", "show", job_id)["job"]["state"] == "completed"
        selected = invoke("analysis", "select", "--job", job_id, "--artifact", artifact_id)
        assert selected["total"] == 1
        compared = invoke(
            "analysis",
            "compare",
            "--left-job",
            job_id,
            "--left-artifact",
            artifact_id,
            "--right-job",
            job_id,
            "--right-artifact",
            artifact_id,
        )
        assert compared["left_count"] == compared["right_count"] == 1
        exported = invoke(
            "analysis",
            "export",
            "--job",
            job_id,
            "--artifact",
            artifact_id,
            "--format",
            "csv",
            "--receipt",
            str(tmp_path / "export-run.json"),
            "--output",
            str(tmp_path / "csv"),
        )
        assert exported["job"]["state"] == "completed"
        assert Path(exported["downloads"][0]["path"]).suffix == ".csv"
        relocated = invoke(
            "runs",
            "resume",
            str(tmp_path / "export-run.json"),
            "--output",
            str(tmp_path / "relocated"),
        )
        assert relocated["downloads"][0]["path"] != exported["downloads"][0]["path"]
        redownloaded = invoke("runs", "resume", str(tmp_path / "export-run.json"))
        assert redownloaded["downloads"] == relocated["downloads"]
        assert invoke("runs", "list", "--directory", str(tmp_path))["total"] == 2
    finally:
        server.should_exit = True
        thread.join(15)
        listener.close()
        assert not thread.is_alive()
