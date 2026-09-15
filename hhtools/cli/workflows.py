"""Workflow-oriented CLI orchestration over the public resident Runtime client."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from hhtools.cli.presentation import Output
from hhtools.client import RuntimeClient, RuntimeClientError
from hhtools.client.discovery import connect_or_start
from hhtools.client.runtime import client_error
from hhtools.contracts import (
    AssetRegistrationRequest,
    BatchPreflightRequest,
    R2RPreflightRequest,
    RetargetPreflightRequest,
)
from hhtools.contracts.execution import TrajectoryExportOptions
from hhtools.contracts.jobs import IdempotencyKey
from hhtools.contracts.validation import validation_details
from hhtools.contracts.workflows import WorkflowPreflightRequest

_PREFLIGHT = {
    "h2r": "hhtools_preflight_retarget",
    "r2r": "hhtools_preflight_r2r",
    "analysis": "hhtools_workflow_preflight",
    "video2motion": "hhtools_workflow_preflight",
}
_OUTPUT_KIND = {
    "h2r": "retargeted_motion",
    "r2r": "retargeted_motion",
    "analysis": "analysis_report",
    "video2motion": "motion",
    "analysis-export": "dataset_manifest",
}


class WorkflowParser(argparse.ArgumentParser):
    def error(self, message):
        raise client_error("INVALID_PARAMETER", message)


def _parse_args(parser, argv):
    """Allow positional inputs before, between, and after options."""
    if hasattr(parser, "parse_intermixed_args"):
        return parser.parse_intermixed_args(argv)
    return parser.parse_args(argv)


def _parser(workflow):
    parser = WorkflowParser(
        prog=f"hhtools {workflow}",
        description="Preflight, submit, wait and optionally download using one persistent Runtime.",
        epilog=(
            "The optional 'run' spelling remains compatible. TTYs show a summary; "
            "use --json for strict JSON."
            + (
                " Analysis actions: select, compare, export (ACTION --help)."
                if workflow == "analysis"
                else ""
            )
        ),
        allow_abbrev=False,
    )
    parser.add_argument("inputs", nargs="*", help="Local files/bundles or registered asset IDs.")
    parser.add_argument("--request", type=Path, help="Preflight JSON document; '-' reads stdin.")
    parser.add_argument("--parameters", type=Path, help="Workflow parameter overrides as JSON.")
    parser.add_argument("--endpoint", default=os.environ.get("HHTOOLS_RUNTIME_ENDPOINT"))
    parser.add_argument("--workspace", type=Path, default=Path("assets/save_npz"))
    parser.add_argument("--token-env", default="HHTOOLS_RUNTIME_TOKEN")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true", help="Strict JSON; no progress output.")
    output.add_argument(
        "--human", action="store_true", help="Readable output even when redirected."
    )
    parser.add_argument(
        "--quiet", action="store_true", help="Suppress progress; keep final results."
    )
    parser.add_argument(
        "--idempotency-key", help="Caller-owned key; otherwise generated and saved."
    )
    parser.add_argument(
        "--receipt", type=Path, help="New recovery file; default: .hhtools-client/runs/<id>.json."
    )
    parser.add_argument(
        "--resume",
        type=Path,
        help="Recover a saved submission without re-uploading or re-planning.",
    )
    wait = parser.add_mutually_exclusive_group()
    wait.add_argument("--wait", dest="wait", action="store_true", default=True)
    wait.add_argument(
        "--no-wait", dest="wait", action="store_false", help="Return after submission."
    )
    parser.add_argument(
        "--wait-timeout",
        type=float,
        default=300,
        help="Maximum wait in seconds; 0 waits indefinitely.",
    )
    parser.add_argument(
        "--output", "-o", type=Path, help="Directory for verified primary artifacts."
    )
    parser.add_argument(
        "--overwrite", action="store_true", help="Allow replacing downloaded files."
    )
    if workflow in {"h2r", "r2r"}:
        parser.add_argument(
            "--batch",
            action="store_true",
            help="Preflight all inputs and submit one ordered batch.",
        )
        parser.add_argument(
            "--mode", choices=["smoke", "full"], help="Execution scope; defaults to smoke."
        )
        parser.add_argument(
            "--backend", choices=["newton", "interaction_mesh"] if workflow == "h2r" else ["newton"]
        )
        parser.add_argument("--limit-frames", type=int)
        parser.add_argument("--ik-iterations", type=int)
        parser.add_argument("--retarget-fps", type=float)
        parser.add_argument("--format", choices=["csv", "pkl"])
        for role in ["robot"] if workflow == "h2r" else ["source-robot", "target-robot"]:
            parser.add_argument("--" + role, help="Installed Runtime robot ID.")
            bundle = parser.add_mutually_exclusive_group()
            bundle.add_argument("--" + role + "-asset", help="Registered robot bundle ID.")
            bundle.add_argument(
                "--" + role + "-bundle", type=Path, help="Local robot directory to upload."
            )
        if workflow == "h2r":
            parser.add_argument("--human-height", type=float)
        else:
            parser.add_argument("--source-fps", type=float)
    elif workflow == "analysis":
        parser.add_argument("--embedding", choices=["handcrafted", "pae"])
    elif workflow == "video2motion":
        camera = parser.add_mutually_exclusive_group()
        camera.add_argument(
            "--static-camera", dest="static_camera", action="store_true", default=None
        )
        camera.add_argument("--moving-camera", dest="static_camera", action="store_false")
        parser.add_argument("--focal-length-mm", type=int)
    return parser


def _document(path):
    from hhtools.cli.agent_transport import loads_strict_json

    value = loads_strict_json(sys.stdin.read() if str(path) == "-" else path.read_text("utf-8"))
    if not isinstance(value, dict):
        raise client_error("INVALID_PARAMETER", "A JSON object is required.")
    return value


def _save(path, document, *, create=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".hhtools-receipt-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(document, stream, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if create:
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _put(document, target, value):
    for key in target[:-1]:
        document = document[key]
    document[target[-1]] = value


def _prepare(workflow, args):
    uploads = []

    def asset(value, kind, target):
        if str(value).startswith("asset:"):
            return str(value)
        path = Path(value).expanduser().absolute()
        uploads.append({"source": str(path), "kind": kind, "target": target})
        return None

    if args.request:
        request = _document(args.request)
        if "request" in request and len(request) == 1:
            request = request["request"]
        if not isinstance(request, dict):
            raise client_error("INVALID_PARAMETER", "The preflight request must be a JSON object.")
    else:
        request = {}
        kinds = {"h2r": "motion_bundle", "r2r": "robot_trajectory_bundle", "video2motion": "video"}
        ids = [
            asset(
                value,
                kinds.get(
                    workflow,
                    "dataset_bundle" if Path(value).expanduser().is_dir() else "motion_bundle",
                ),
                ["motion_asset_id" if workflow == "h2r" else "trajectory_asset_id"]
                if workflow in {"h2r", "r2r"}
                else ["asset_ids", index],
            )
            for index, value in enumerate(args.inputs)
        ]
        if workflow in {"h2r", "r2r"}:
            request["motion_asset_id" if workflow == "h2r" else "trajectory_asset_id"] = ids[0]
        else:
            request.update(
                workflow="analysis" if workflow == "analysis" else "video_to_motion", asset_ids=ids
            )
    if not isinstance(request.get("parameters", {}), dict):
        raise client_error("INVALID_PARAMETER", "parameters must be a JSON object.")
    parameters = dict(request.get("parameters", {}))
    if args.parameters:
        parameters.update(args.parameter_document)
    for name in (
        "limit_frames",
        "ik_iterations",
        "retarget_fps",
        "human_height",
        "source_fps",
        "embedding",
        "static_camera",
        "focal_length_mm",
    ):
        value = getattr(args, name, None)
        if value is not None:
            parameters[name] = value
    if workflow in {"h2r", "r2r"}:
        if args.mode:
            parameters["run_mode"] = args.mode
        for field, flag in (("backend", "backend"), ("output_format", "format")):
            if getattr(args, flag):
                request[field] = getattr(args, flag)
        for role in ["robot"] if workflow == "h2r" else ["source_robot", "target_robot"]:
            if getattr(args, role):
                request[role + "_id"] = getattr(args, role)
            bundle, asset_id = getattr(args, role + "_bundle"), getattr(args, role + "_asset")
            if bundle or asset_id:
                request[role + "_asset_id"] = asset(
                    bundle or asset_id, "robot_bundle", [role + "_asset_id"]
                )
    request["parameters"] = parameters
    model = {"h2r": RetargetPreflightRequest, "r2r": R2RPreflightRequest}.get(
        workflow, WorkflowPreflightRequest
    )
    # Deferred identities are used only to validate the shape, never sent to the Runtime.
    check = copy.deepcopy(request)
    for index, upload in enumerate(uploads):
        _put(check, upload["target"], "asset:sha256:" + f"{index:064x}")
    if workflow in {"h2r", "r2r"}:
        _retarget_parameters(workflow, check["parameters"])
    validated = model.model_validate(check).model_dump(mode="json")
    if workflow in {"analysis", "video2motion"} and validated["workflow"] != (
        "analysis" if workflow == "analysis" else "video_to_motion"
    ):
        raise client_error("INVALID_PARAMETER", "The request belongs to a different workflow.")
    for upload in uploads:
        _put(validated, upload["target"], None)
        path = Path(upload["source"])
        if not path.exists() or path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise client_error(
                "INVALID_INPUT", "Local inputs must be existing files or directories without links."
            )
        members = list(path.rglob("*")) if path.is_dir() else [path]
        if any(item.is_symlink() for item in members):
            raise client_error("INVALID_INPUT", "Input bundles must not contain symbolic links.")
        if not any(item.is_file() for item in members):
            raise client_error("INVALID_INPUT", "Input bundles must contain at least one file.")
    return {"request": validated, "uploads": uploads}


def _retarget_parameters(workflow, parameters):
    allowed = {"run_mode", "limit_frames", "ik_iterations", "retarget_fps", "export"}
    allowed |= (
        {"human_height", "foot_clamp_anti_penetration"} if workflow == "h2r" else {"source_fps"}
    )
    if set(parameters) - allowed:
        raise client_error(
            "INVALID_PARAMETER",
            "Unknown retarget parameters: " + ", ".join(sorted(set(parameters) - allowed)),
        )
    for name in ("ik_iterations", "limit_frames", "retarget_fps", "source_fps", "human_height"):
        value = parameters.get(name)
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, (float, int))
            or not math.isfinite(value)
            or value <= (0.1 if name == "human_height" else 0)
        ):
            raise client_error(
                "INVALID_PARAMETER", f"parameters.{name} must be finite and positive."
            )
        if (
            value is not None
            and name in {"ik_iterations", "limit_frames"}
            and not isinstance(value, int)
        ):
            raise client_error("INVALID_PARAMETER", f"parameters.{name} must be an integer.")
    if parameters.get("run_mode", "smoke") not in {"smoke", "full"}:
        raise client_error("INVALID_PARAMETER", "run_mode must be smoke or full.")
    if parameters.get("run_mode") == "full" and parameters.get("limit_frames") is not None:
        raise client_error("INVALID_PARAMETER", "A full run cannot set limit_frames.")
    if parameters.get("export") is not None:
        TrajectoryExportOptions.model_validate(parameters["export"])


def _resolve(client, prepared, receipt, path, output):
    for upload in prepared["uploads"]:
        if not upload.get("asset_id"):

            def save_session(upload_id, upload=upload):
                upload["upload_id"] = upload_id
                _save(path, receipt)

            output.stage("Hashing " + upload["source"])
            asset = client.upload(
                Path(upload["source"]),
                kind=upload["kind"],
                upload_id=upload.get("upload_id"),
                on_session=save_session,
                on_progress=output.transfer("Uploading " + Path(upload["source"]).name),
            )
            upload["asset_id"] = asset["asset_id"]
        _put(prepared["request"], upload["target"], upload["asset_id"])
        _save(path, receipt)
    return prepared["request"]


def _preflight(client, workflow, request):
    handled = set()
    for _ in range(5):
        result = client.call(_PREFLIGHT[workflow], {"request": request})
        if "plan_id" in result or result.get("status") == "ready":
            return result
        error = result.get("error") or {}
        actions = result.get("required_actions") or [error.get("next_action")]
        action = next((item for item in actions if item and item.get("actor") == "agent"), None)
        if not action or json.dumps(action, sort_keys=True) in handled:
            return result
        handled.add(json.dumps(action, sort_keys=True))
        name, values = action.get("action"), action.get("parameters", {})
        if name == "register_asset_bundle":
            registration = AssetRegistrationRequest.model_validate(values.get("request"))
            robot = error.get("details", {}).get("robot_id")
            roles = [
                key[:-3]
                for key, value in request.items()
                if key.endswith("robot_id") and value == robot
            ]
            if len(roles) != 1:
                return result
            asset = client.call(
                "hhtools_register_asset", {"request": registration.model_dump(mode="json")}
            )
            request[roles[0] + "_asset_id"] = asset["asset_id"]
        elif name in {"get_calibration_status", "get_r2r_calibration_status"}:
            client.call(
                "hhtools_calibration_status"
                if name == "get_calibration_status"
                else "hhtools_r2r_calibration_status",
                values,
            )
        else:
            return result
    return result


def _complete(client, workflow, args, receipt, path):
    output = args.presentation
    if receipt.get("job_id"):
        job = client.call("hhtools_runtime_get_job", {"job_id": receipt["job_id"]})
    else:
        submission = {
            "request": {
                "plan_id": receipt["plan_id"],
                "idempotency_key": receipt["idempotency_key"],
            }
        }
        try:
            job = client.call("hhtools_runtime_lookup_job", submission)
        except RuntimeClientError as error:
            if error.api_error.code != "JOB_NOT_FOUND":
                raise
            job = client.call("hhtools_runtime_start_job", submission)
        receipt["job_id"] = job["job_id"]
        _save(path, receipt)
    deadline = time.monotonic() + args.wait_timeout if args.wait_timeout else float("inf")
    while args.wait and job["state"] in {"queued", "running"}:
        output.job(job)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        job = client.call(
            "hhtools_runtime_wait_job",
            {
                "job_id": job["job_id"],
                "after_revision": job["progress"]["revision"],
                "timeout_seconds": min(25, remaining),
            },
        )
    result = {
        "workflow": workflow,
        "receipt": str(path),
        "runtime_id": client.runtime_id,
        "workspace_id": client.workspace_id,
        "job": job,
        "downloads": [],
        "wait_timed_out": args.wait and job["state"] in {"queued", "running"},
    }
    if args.output and job["state"] == "completed":
        offset = 0
        while True:
            page = client.call(
                "hhtools_runtime_list_artifacts",
                {"job_id": job["job_id"], "offset": offset, "limit": 100},
            )
            for artifact in page["artifacts"]:
                if artifact["kind"] == (
                    "batch_archive" if receipt.get("batch") else _OUTPUT_KIND[workflow]
                ) or (workflow == "analysis-export" and artifact["kind"] == "dataset_bundle"):
                    suffix = artifact.get("format") or "bin"
                    if not suffix.isalnum():
                        raise client_error("INVALID_RESPONSE", "Invalid artifact format.")
                    destination = args.output / (
                        artifact["kind"] + "-" + artifact["sha256"][:16] + "." + suffix
                    )
                    saved = receipt.setdefault("downloads", {})
                    acknowledged = saved.get(artifact["artifact_id"]) == str(destination.absolute())
                    valid = False
                    if acknowledged and destination.is_file():
                        with destination.open("rb") as stream:
                            valid = (
                                hashlib.file_digest(stream, "sha256").hexdigest()
                                == artifact["sha256"]
                            )
                    if not valid:
                        client.download(
                            job["job_id"],
                            artifact["artifact_id"],
                            destination,
                            overwrite=args.overwrite,
                            on_progress=output.transfer("Downloading " + destination.name),
                        )
                    saved[artifact["artifact_id"]] = str(destination.absolute())
                    _save(path, receipt)
                    result["downloads"].append(
                        {
                            "artifact_id": artifact["artifact_id"],
                            "path": str(destination),
                            "sha256": artifact["sha256"],
                        }
                    )
            offset += len(page["artifacts"])
            if offset >= page["total"] or not page["artifacts"]:
                break
    return result, 1 if job["state"] in {"failed", "cancelled"} or job.get("outcome") in {
        "partial",
        "rejected",
    } else 0


def run(workflow, argv):
    args = None
    path = None
    output = Output(json_mode="--json" in argv, human="--human" in argv, quiet="--quiet" in argv)
    try:
        argv = list(argv)
        if argv[:1] == ["run"]:
            argv.pop(0)
        args = _parse_args(_parser(workflow), argv or ["--help"])
        output = Output(json_mode=args.json, human=args.human, quiet=args.quiet)
        args.presentation = output
        if args.wait_timeout < 0 or not math.isfinite(args.wait_timeout):
            raise client_error(
                "INVALID_PARAMETER", "--wait-timeout must be finite and nonnegative."
            )
        if args.resume:
            change_flags = {
                "robot",
                "source_robot",
                "target_robot",
                "robot_asset",
                "source_robot_asset",
                "target_robot_asset",
                "robot_bundle",
                "source_robot_bundle",
                "target_robot_bundle",
                "mode",
                "backend",
                "format",
                "limit_frames",
                "ik_iterations",
                "retarget_fps",
                "source_fps",
                "human_height",
                "embedding",
                "static_camera",
                "focal_length_mm",
            }
            if any(vars(args).get(flag) is not None for flag in change_flags):
                raise client_error(
                    "INVALID_PARAMETER", "A recovered plan cannot accept new workflow options."
                )
            if (
                args.inputs
                or args.request
                or args.parameters
                or args.receipt
                or args.idempotency_key
                or getattr(args, "batch", False)
            ):
                raise client_error(
                    "INVALID_PARAMETER",
                    "--resume cannot be combined with new submission arguments.",
                )
            path = args.resume.expanduser().resolve()
            receipt = _document(path)
            if receipt.get("workflow") != workflow or receipt.get("version") not in {1, 2}:
                raise client_error(
                    "INVALID_PARAMETER", "The receipt belongs to another workflow or version."
                )
            client = RuntimeClient(
                args.endpoint or receipt["endpoint"],
                token=os.environ.get(args.token_env),
                runtime_id=receipt["runtime_id"],
                workspace_id=receipt["workspace_id"],
            )
            client.connect()
        else:
            if args.inputs and args.request:
                raise client_error(
                    "INVALID_PARAMETER", "Choose positional inputs or --request, not both."
                )
            if not args.request and (
                not args.inputs
                or (workflow in {"h2r", "r2r"} and len(args.inputs) != 1 and not args.batch)
            ):
                raise client_error(
                    "INVALID_PARAMETER",
                    "Provide one H2R/R2R bundle, or one or more Analysis/Video2Motion inputs.",
                )
            path = (
                (args.receipt or Path(".hhtools-client/runs") / (uuid.uuid4().hex + ".json"))
                .expanduser()
                .resolve()
            )
            if path.exists():
                raise client_error(
                    "OUTPUT_EXISTS", "Receipt already exists; use --resume to recover it."
                )
            key = TypeAdapter(IdempotencyKey).validate_python(
                args.idempotency_key or uuid.uuid4().hex
            )
            if args.parameters:
                args.parameter_document = _document(args.parameters)
            if getattr(args, "batch", False):
                if args.request:
                    raise client_error(
                        "INVALID_PARAMETER",
                        "--batch takes positional inputs; --request is a single preflight request.",
                    )
                prepared = []
                for value in args.inputs:
                    child = copy.copy(args)
                    child.inputs = [value]
                    prepared.append(_prepare(workflow, child))
            else:
                prepared = [_prepare(workflow, args)]
            if args.output:
                args.output = args.output.expanduser().absolute()
                if args.output.exists() and not args.output.is_dir():
                    raise client_error("INVALID_OUTPUT", "--output must be a directory.")
            output.stage("Connecting to Runtime")
            client = (
                RuntimeClient(args.endpoint, token=os.environ.get(args.token_env))
                if args.endpoint
                else connect_or_start(args.workspace)
            )
            identity = client.connect()
            receipt = {
                "version": 2,
                "workflow": workflow,
                "endpoint": client.endpoint,
                "runtime_id": identity["runtime_id"],
                "workspace_id": identity["workspace_id"],
                "idempotency_key": key,
                "prepared": prepared,
                "batch": getattr(args, "batch", False),
                "output": str(args.output) if args.output else None,
            }
            _save(path, receipt, create=True)
        output.stage("Receipt: " + str(path))
        if not args.output and receipt.get("output"):
            args.output = Path(receipt["output"])
        if args.output:
            args.output = args.output.expanduser().absolute()
            if args.output.exists() and not args.output.is_dir():
                raise client_error("INVALID_OUTPUT", "--output must be a directory.")
            receipt["output"] = str(args.output)
            _save(path, receipt)
        if not receipt.get("plan_id"):
            plans = []
            for prepared in receipt["prepared"]:
                if not prepared.get("plan_id"):
                    request = _resolve(client, prepared, receipt, path, output)
                    output.stage("Checking workflow prerequisites")
                    preflight = _preflight(client, workflow, request)
                    _save(path, receipt)
                    plan = preflight.get("plan") or preflight
                    if not plan.get("plan_id"):
                        output.emit(
                            {"workflow": workflow, "receipt": str(path), "preflight": preflight}
                        )
                        return 3
                    prepared["plan_id"] = plan["plan_id"]
                    _save(path, receipt)
                plans.append(prepared["plan_id"])
            if receipt.get("batch"):
                body = BatchPreflightRequest(workflow=workflow, item_plan_ids=plans).model_dump(
                    mode="json"
                )
                preflight = client.call("hhtools_preflight_batch", {"request": body})
                if preflight.get("status") != "ready":
                    output.emit(
                        {"workflow": workflow, "receipt": str(path), "preflight": preflight}
                    )
                    return 3
                receipt["plan_id"] = preflight["plan"]["plan_id"]
            else:
                receipt["plan_id"] = plans[0]
            _save(path, receipt)
        output.stage("Submitting or recovering job")
        result, code = _complete(client, workflow, args, receipt, path)
        output.emit(result)
        return code
    except SystemExit as error:
        return error.code
    except RuntimeClientError as error:
        document = error.api_error.model_dump(mode="json")
    except ValidationError as error:
        document = client_error(
            "INVALID_PARAMETER", "Workflow parameters are invalid."
        ).api_error.model_dump(mode="json")
        document["details"] = validation_details(error.errors())
    except (OSError, ValueError, KeyError, TypeError) as error:
        document = client_error(
            "INVALID_PARAMETER", "Could not read workflow input or recovery data."
        ).api_error.model_dump(mode="json")
        document["details"] = {"exception_type": type(error).__name__}
    except KeyboardInterrupt:
        document = client_error(
            "CLIENT_INTERRUPTED", "Client stopped waiting; the Runtime job is retained."
        ).api_error.model_dump(mode="json")
    if path and path.is_file():
        document["details"]["receipt"] = str(path)
    output.emit(document)
    return 130 if document["code"] == "CLIENT_INTERRUPTED" else 2
