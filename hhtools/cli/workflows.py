"""Workflow-oriented CLI orchestration over the public resident Runtime client."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

from pydantic import ValidationError

from hhtools.client import RuntimeClient, RuntimeClientError
from hhtools.client.discovery import connect_or_start
from hhtools.client.runtime import client_error
from hhtools.contracts import (
    AssetRegistrationRequest,
    R2RPreflightRequest,
    RetargetPreflightRequest,
)
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
}


class WorkflowParser(argparse.ArgumentParser):
    def error(self, message):
        raise client_error("INVALID_PARAMETER", message)


def _parser(workflow):
    parser = WorkflowParser(
        prog=f"hhtools {workflow}",
        description="Preflight, submit, wait and optionally download using one persistent Runtime.",
        epilog="The optional 'run' spelling remains compatible. JSON is always written to stdout.",
        allow_abbrev=False,
    )
    parser.add_argument("inputs", nargs="*", help="Local files/bundles or registered asset IDs.")
    parser.add_argument("--request", type=Path, help="Preflight JSON document; '-' reads stdin.")
    parser.add_argument("--parameters", type=Path, help="Workflow parameter overrides as JSON.")
    parser.add_argument("--endpoint", default=os.environ.get("HHTOOLS_RUNTIME_ENDPOINT"))
    parser.add_argument("--workspace", type=Path, default=Path("assets/save_npz"))
    parser.add_argument("--token-env", default="HHTOOLS_RUNTIME_TOKEN")
    parser.add_argument(
        "--json", action="store_true", help="Explicit JSON mode (also the default)."
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
    else:
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


def _asset(client, value, kind):
    if str(value).startswith("asset:"):
        return str(value)
    path = Path(value).expanduser()
    return client.upload(path, kind=kind)["asset_id"]


def _request(client, workflow, args):
    if args.request:
        request = _document(args.request)
        if "request" in request and len(request) == 1:
            request = request["request"]
    else:
        request = {}
        kinds = {"h2r": "motion_bundle", "r2r": "robot_trajectory_bundle", "video2motion": "video"}
        ids = [
            _asset(
                client,
                value,
                kinds.get(
                    workflow,
                    "dataset_bundle" if Path(value).expanduser().is_dir() else "motion_bundle",
                ),
            )
            for value in args.inputs
        ]
        if workflow in {"h2r", "r2r"}:
            request["motion_asset_id" if workflow == "h2r" else "trajectory_asset_id"] = ids[0]
        else:
            request.update(
                workflow="analysis" if workflow == "analysis" else "video_to_motion", asset_ids=ids
            )
    parameters = dict(request.get("parameters", {}))
    if args.parameters:
        parameters.update(_document(args.parameters))
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
            bundle, asset = getattr(args, role + "_bundle"), getattr(args, role + "_asset")
            if bundle or asset:
                request[role + "_asset_id"] = _asset(client, bundle or asset, "robot_bundle")
    request["parameters"] = parameters
    model = {"h2r": RetargetPreflightRequest, "r2r": R2RPreflightRequest}.get(
        workflow, WorkflowPreflightRequest
    )
    validated = model.model_validate(request).model_dump(mode="json")
    if workflow in {"analysis", "video2motion"} and validated["workflow"] != (
        "analysis" if workflow == "analysis" else "video_to_motion"
    ):
        raise client_error("INVALID_PARAMETER", "The request belongs to a different workflow.")
    return validated


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
    }
    if args.output and job["state"] == "completed":
        offset = 0
        while True:
            page = client.call(
                "hhtools_runtime_list_artifacts",
                {"job_id": job["job_id"], "offset": offset, "limit": 100},
            )
            for artifact in page["artifacts"]:
                if artifact["kind"] == _OUTPUT_KIND[workflow]:
                    suffix = artifact.get("format") or "bin"
                    if not suffix.isalnum():
                        raise client_error("INVALID_RESPONSE", "Invalid artifact format.")
                    destination = args.output / (
                        artifact["kind"] + "-" + artifact["sha256"][:16] + "." + suffix
                    )
                    client.download(
                        job["job_id"],
                        artifact["artifact_id"],
                        destination,
                        overwrite=args.overwrite,
                    )
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
    try:
        argv = list(argv)
        if argv[:1] == ["run"]:
            argv.pop(0)
        args = _parser(workflow).parse_args(argv or ["--help"])
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
            ):
                raise client_error(
                    "INVALID_PARAMETER",
                    "--resume cannot be combined with new submission arguments.",
                )
            path = args.resume.expanduser().resolve()
            receipt = _document(path)
            if receipt.get("workflow") != workflow or receipt.get("version") != 1:
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
                not args.inputs or (workflow in {"h2r", "r2r"} and len(args.inputs) != 1)
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
            client = (
                RuntimeClient(args.endpoint, token=os.environ.get(args.token_env))
                if args.endpoint
                else connect_or_start(args.workspace)
            )
            identity = client.connect()
            request = _request(client, workflow, args)
            preflight = _preflight(client, workflow, request)
            plan = preflight.get("plan") or preflight
            if not plan.get("plan_id"):
                print(
                    json.dumps({"workflow": workflow, "preflight": preflight}, ensure_ascii=False)
                )
                return 3
            receipt = {
                "version": 1,
                "workflow": workflow,
                "endpoint": client.endpoint,
                "runtime_id": identity["runtime_id"],
                "workspace_id": identity["workspace_id"],
                "plan_id": plan["plan_id"],
                "idempotency_key": args.idempotency_key or uuid.uuid4().hex,
            }
            _save(path, receipt, create=True)
        result, code = _complete(client, workflow, args, receipt, path)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
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
    print(json.dumps(document, ensure_ascii=False, allow_nan=False))
    return 130 if document["code"] == "CLIENT_INTERRUPTED" else 2
