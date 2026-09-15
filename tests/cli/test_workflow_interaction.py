"""CLI validation, presentation, recovery, task management and batching."""

import json

import pytest

from hhtools.cli import operations, workflows
from hhtools.client.runtime import client_error

ASSET = "asset:sha256:" + "a" * 64
OTHER = "asset:sha256:" + "b" * 64
PLAN = "plan:sha256:" + "c" * 64


class Runtime:
    endpoint = "http://localhost:9999"
    runtime_id = "runtime:test"
    workspace_id = "workspace:test"

    def __init__(self):
        self.calls = []
        self.uploads = []
        self.submitted = False
        self.interrupt_upload = False

    def connect(self):
        self.calls.append(("connect", {}))
        return {"runtime_id": self.runtime_id, "workspace_id": self.workspace_id}

    def upload(self, path, **kwargs):
        self.uploads.append((path, kwargs.get("upload_id")))
        kwargs["on_session"]("u" * 32)
        kwargs["on_progress"](0, 6)
        if self.interrupt_upload:
            self.interrupt_upload = False
            raise client_error("RUNTIME_UNAVAILABLE", "Interrupted", retryable=True)
        kwargs["on_progress"](6, 6)
        return {"asset_id": ASSET if len(self.uploads) == 1 else OTHER}

    def call(self, operation, args=None):
        self.calls.append((operation, args))
        job = {
            "job_id": "job:1",
            "state": "completed",
            "outcome": "success",
            "progress": {"phase": "done", "revision": 2, "fraction": 1},
        }
        if operation == "hhtools_preflight_retarget":
            return {
                "status": "ready",
                "plan": {
                    "plan_id": "plan:sha256:" + args["request"]["motion_asset_id"].split(":")[-1]
                },
            }
        if operation == "hhtools_preflight_batch":
            return {"status": "ready", "plan": {"plan_id": PLAN}}
        if "preflight" in operation:
            return {"plan_id": PLAN}
        if operation == "hhtools_runtime_lookup_job" and not self.submitted:
            raise client_error("JOB_NOT_FOUND", "Not found")
        if operation == "hhtools_runtime_start_job":
            self.submitted = True
            return {
                **job,
                "state": "running",
                "progress": {"revision": 1, "phase": "analysis", "fraction": 0.5},
            }
        if operation == "hhtools_runtime_list_jobs":
            return {"jobs": [job], "total": 1}
        return job


@pytest.fixture
def runtime(monkeypatch):
    runtime = Runtime()
    for module in (workflows, operations):
        monkeypatch.setattr(module, "connect_or_start", lambda *args, **kwargs: runtime)
        monkeypatch.setattr(module, "RuntimeClient", lambda *args, **kwargs: runtime)
    return runtime


@pytest.mark.parametrize(
    "workflow,args",
    [
        ("h2r", ["motion.npz"]),
        ("r2r", ["motion.csv", "--source-robot", "g1"]),
        ("r2r", [ASSET, "--source-robot", "g1", "--target-robot", "rp1", "--source-fps", "nan"]),
        ("h2r", [ASSET, "--robot", "g1", "--mode", "full", "--limit-frames", "10"]),
        ("analysis", ["does-not-exist.npz"]),
        ("video2motion", ["video.mp4", "--focal-length-mm", "0"]),
    ],
)
def test_invalid_inputs_never_connect_or_upload(runtime, tmp_path, capsys, workflow, args):
    assert workflows.run(workflow, [*args, "--json", "--receipt", str(tmp_path / "run.json")]) == 2
    assert json.loads(capsys.readouterr().out)["code"] in {"INVALID_PARAMETER", "INVALID_INPUT"}
    assert not runtime.calls and not runtime.uploads
    assert not (tmp_path / "run.json").exists()


def test_request_and_parameter_files_are_validated_before_runtime(runtime, tmp_path, capsys):
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"workflow": "analysis", "asset_ids": [ASSET]}))
    parameters = tmp_path / "parameters.json"
    parameters.write_text(json.dumps({"metric_config": {"unknown_threshold": 1}}))
    assert (
        workflows.run(
            "analysis", ["--request", str(request), "--parameters", str(parameters), "--json"]
        )
        == 2
    )
    assert json.loads(capsys.readouterr().out)["details"]["fields"]
    assert not runtime.calls


@pytest.mark.parametrize(
    "body",
    [
        {"request": "not-an-object"},
        {"workflow": "analysis", "asset_ids": [ASSET], "parameters": []},
    ],
)
def test_malformed_request_shapes_stay_local(runtime, tmp_path, capsys, body):
    request = tmp_path / "request.json"
    request.write_text(json.dumps(body))
    assert workflows.run("analysis", ["--request", str(request), "--json"]) == 2
    assert json.loads(capsys.readouterr().out)["code"] == "INVALID_PARAMETER"
    assert not runtime.calls


def test_interleaved_inputs_and_options_and_quiet_json(runtime, tmp_path, capsys):
    assert (
        workflows.run("analysis", [ASSET, "--json", "--receipt", str(tmp_path / "run.json"), OTHER])
        == 0
    )
    streams = capsys.readouterr()
    document = json.loads(streams.out)
    assert document["job"]["state"] == "completed"
    assert streams.err == ""
    request = next(
        args["request"] for name, args in runtime.calls if name == "hhtools_workflow_preflight"
    )
    assert request["asset_ids"] == [ASSET, OTHER]


def test_human_summary_and_progress_include_recovery_path(runtime, tmp_path, capsys):
    source = tmp_path / "motion.npz"
    source.write_bytes(b"upload")
    assert (
        workflows.run("analysis", [str(source), "--human", "--receipt", str(tmp_path / "run.json")])
        == 0
    )
    streams = capsys.readouterr()
    assert "analysis: completed (success)" in streams.out
    assert "Job: job:1" in streams.out
    assert "Receipt:" in streams.out
    assert "Connecting" in streams.err and "Uploading" in streams.err and "100%" in streams.err
    assert "running analysis 50%" in streams.err


def test_upload_failure_resumes_without_new_manifest_or_request_file(runtime, tmp_path, capsys):
    source = tmp_path / "motion.npz"
    source.write_bytes(b"upload")
    path = tmp_path / "run.json"
    runtime.interrupt_upload = True
    assert workflows.run("analysis", [str(source), "--json", "--receipt", str(path)]) == 2
    assert json.loads(capsys.readouterr().out)["details"]["receipt"] == str(path)
    document = json.loads(path.read_text())
    assert document["prepared"][0]["uploads"][0]["upload_id"] == "u" * 32
    assert not runtime.submitted
    assert operations.run("runs", ["resume", str(path), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["job"]["job_id"] == "job:1"
    assert runtime.uploads == [(source, None), (source, "u" * 32)]
    assert sum(name == "hhtools_runtime_start_job" for name, _ in runtime.calls) == 1


def test_batch_preserves_plan_order_and_submits_once(runtime, tmp_path, capsys):
    assert (
        workflows.run(
            "h2r",
            [
                ASSET,
                "--batch",
                "--robot",
                "g1",
                OTHER,
                "--json",
                "--receipt",
                str(tmp_path / "batch.json"),
            ],
        )
        == 0
    )
    assert json.loads(capsys.readouterr().out)["job"]["state"] == "completed"
    plans = next(
        args["request"]["item_plan_ids"]
        for name, args in runtime.calls
        if name == "hhtools_preflight_batch"
    )
    assert plans == ["plan:sha256:" + "a" * 64, "plan:sha256:" + "b" * 64]
    assert sum(name == "hhtools_runtime_start_job" for name, _ in runtime.calls) == 1


def test_batch_reads_stdin_parameters_once(runtime, tmp_path, capsys, monkeypatch):
    import io

    monkeypatch.setattr(workflows.sys, "stdin", io.StringIO('{"run_mode":"smoke"}'))
    assert (
        workflows.run(
            "h2r",
            [
                ASSET,
                OTHER,
                "--batch",
                "--robot",
                "g1",
                "--parameters",
                "-",
                "--json",
                "--receipt",
                str(tmp_path / "run.json"),
            ],
        )
        == 0
    )
    assert json.loads(capsys.readouterr().out)["job"]["state"] == "completed"


def test_nonready_batch_child_prevents_submission(runtime, tmp_path, capsys):
    original = runtime.call

    def call(name, args=None):
        if name == "hhtools_preflight_retarget" and args["request"]["motion_asset_id"] == OTHER:
            return {"status": "rejected", "error": {"code": "NO_CALIBRATION", "message": "Missing"}}
        return original(name, args)

    runtime.call = call
    assert (
        workflows.run(
            "h2r",
            [
                ASSET,
                OTHER,
                "--batch",
                "--robot",
                "g1",
                "--json",
                "--receipt",
                str(tmp_path / "batch.json"),
            ],
        )
        == 3
    )
    assert json.loads(capsys.readouterr().out)["preflight"]["status"] == "rejected"
    assert not runtime.submitted


@pytest.mark.parametrize("action", ["list", "show", "watch", "cancel", "retry", "artifacts"])
def test_job_commands_dispatch_to_public_runtime(runtime, capsys, action):
    args = [action, "--json"] + ([] if action == "list" else ["job:1"])
    if action == "retry":
        args += ["--idempotency-key", "retry-one"]
    assert operations.run("jobs", args) == 0
    json.loads(capsys.readouterr().out)
    expected = {
        "list": "list_jobs",
        "show": "get_job",
        "watch": "get_job",
        "cancel": "cancel_job",
        "retry": "retry_job",
        "artifacts": "list_artifacts",
    }[action]
    assert any(name == "hhtools_runtime_" + expected for name, _ in runtime.calls)


def test_local_run_listing_does_not_connect(runtime, tmp_path, capsys):
    (tmp_path / "receipt.json").write_text(json.dumps({"workflow": "analysis", "job_id": "job:1"}))
    assert operations.run("runs", ["list", "--directory", str(tmp_path), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["runs"][0]["job_id"] == "job:1"
    assert not runtime.calls
