"""Task management, local recovery records, and analysis post-processing commands."""

import argparse
import math
import os
import time
import uuid
from pathlib import Path

from pydantic import ValidationError

from hhtools.cli.presentation import Output
from hhtools.client import RuntimeClient, RuntimeClientError
from hhtools.client.discovery import connect_or_start
from hhtools.client.runtime import client_error
from hhtools.contracts.jobs import JobRetryRequest
from hhtools.contracts.validation import validation_details
from hhtools.contracts.workflows import (
    AnalysisCompareRequest,
    AnalysisExportParameters,
    AnalysisSelectionRequest,
)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise client_error("INVALID_PARAMETER", message)


def _parser(family, action):
    choices = {
        "jobs": "list, show, watch, cancel, retry, artifacts",
        "runs": "list, show, resume",
        "analysis": "select, compare, export",
    }
    parser = Parser(
        prog=f"hhtools {family.replace('-', ' ')} {action}",
        allow_abbrev=False,
        epilog="Actions: " + choices[family] + ". Use ACTION --help for its options.",
    )
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--json", action="store_true")
    modes.add_argument("--human", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--endpoint", default=os.environ.get("HHTOOLS_RUNTIME_ENDPOINT"))
    parser.add_argument("--workspace", type=Path, default=Path("assets/save_npz"))
    parser.add_argument("--token-env", default="HHTOOLS_RUNTIME_TOKEN")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--offset", type=int, default=0)
    if family == "jobs":
        if action != "list":
            parser.add_argument("job_id")
        if action == "watch":
            parser.add_argument("--wait-timeout", type=float, default=300)
        if action == "retry":
            parser.add_argument("--idempotency-key", required=True)
    elif family == "runs":
        parser.add_argument("--directory", type=Path, default=Path(".hhtools-client/runs"))
        if action in {"show", "resume"}:
            parser.add_argument("receipt", type=Path)
        if action == "resume":
            parser.add_argument("--output", type=Path)
            parser.add_argument("--overwrite", action="store_true")
            parser.add_argument("--no-wait", action="store_true")
            parser.add_argument("--wait-timeout", type=float, default=300)
    elif action == "compare":
        parser.add_argument("--left-job", required=True)
        parser.add_argument("--left-artifact", required=True)
        parser.add_argument("--right-job", required=True)
        parser.add_argument("--right-artifact", required=True)
    else:
        parser.add_argument("--job", required=True)
        parser.add_argument("--artifact", required=True)
        parser.add_argument("--tag", action="append", default=[])
        parser.add_argument("--clip-id", action="append", default=[])
        parser.add_argument("--include-errors", action="store_true")
        parser.add_argument(
            "--metric-ranges", type=Path, help="JSON mapping metrics to [minimum, maximum]."
        )
        parser.add_argument("--subset-size", type=int)
        if action == "export":
            parser.add_argument("--format", choices=["json", "csv", "robot_zip"], default="csv")
            parser.add_argument("--output", type=Path)
            parser.add_argument("--receipt", type=Path)
            parser.add_argument("--idempotency-key")
            parser.add_argument("--wait-timeout", type=float, default=300)
            parser.add_argument("--no-wait", dest="wait", action="store_false", default=True)
            parser.add_argument("--overwrite", action="store_true")
    return parser


def _runs(action, args):
    from hhtools.cli.workflows import _document

    if action == "show":
        document = _document(args.receipt)
        return {
            "receipt": str(args.receipt),
            "workflow": document["workflow"],
            "runs": [
                {
                    "receipt": str(args.receipt),
                    "workflow": document["workflow"],
                    "job_id": document.get("job_id"),
                    "state": "submitted" if document.get("job_id") else "prepared",
                }
            ],
            "recovery": document,
        }
    files = sorted(
        args.directory.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True
    )
    rows = []
    for path in files[args.offset : args.offset + args.limit]:
        try:
            document = _document(path)
            rows.append(
                {
                    "receipt": str(path.absolute()),
                    "workflow": document.get("workflow"),
                    "job_id": document.get("job_id"),
                    "state": "submitted" if document.get("job_id") else "prepared",
                }
            )
        except (OSError, ValueError, RuntimeClientError):
            rows.append({"receipt": str(path.absolute()), "state": "unreadable"})
    return {"runs": rows, "total": len(files), "offset": args.offset, "limit": args.limit}


def _job(client, action, args, output):
    if action == "list":
        return client.call(
            "hhtools_runtime_list_jobs", {"offset": args.offset, "limit": args.limit}
        )
    values = {"job_id": args.job_id}
    if action == "artifacts":
        return client.call(
            "hhtools_runtime_list_artifacts", {**values, "offset": args.offset, "limit": args.limit}
        )
    if action == "retry":
        values["request"] = JobRetryRequest(idempotency_key=args.idempotency_key).model_dump(
            mode="json"
        )
    operation = {"cancel": "cancel", "retry": "retry"}.get(action, "get")
    job = client.call(f"hhtools_runtime_{operation}_job", values)
    deadline = (
        time.monotonic() + args.wait_timeout if getattr(args, "wait_timeout", 0) else float("inf")
    )
    while (
        action == "watch" and job["state"] in {"queued", "running"} and time.monotonic() < deadline
    ):
        output.job(job)
        job = client.call(
            "hhtools_runtime_wait_job",
            {
                "job_id": args.job_id,
                "after_revision": job["progress"]["revision"],
                "timeout_seconds": max(0, min(25, deadline - time.monotonic())),
            },
        )
    return {
        "job": job,
        "wait_timed_out": action == "watch" and job["state"] in {"queued", "running"},
    }


def run(family, argv):
    from hhtools.cli.workflows import _complete, _document, _save

    output = Output(json_mode="--json" in argv, human="--human" in argv, quiet="--quiet" in argv)
    receipt_path = None
    try:
        argv = list(argv)
        actions = {
            "jobs": {"list", "show", "watch", "cancel", "retry", "artifacts"},
            "runs": {"list", "show", "resume"},
            "analysis": {"select", "compare", "export"},
        }[family]
        action = argv.pop(0) if argv and argv[0] in actions else "list"
        if family == "runs" and action == "resume":
            resume_args = _parser(family, action).parse_intermixed_args(argv)
            path = resume_args.receipt
            workflow = _document(path).get("workflow")
            from hhtools.cli.workflows import run as run_workflow

            if workflow not in {"h2r", "r2r", "analysis", "video2motion", "analysis-export"}:
                raise client_error("INVALID_PARAMETER", "Unsupported receipt workflow.")
            forwarded = [
                "--resume",
                str(path),
                "--wait-timeout",
                str(resume_args.wait_timeout),
                "--token-env",
                resume_args.token_env,
            ]
            for name in ("json", "human", "quiet", "overwrite", "no_wait"):
                if getattr(resume_args, name):
                    forwarded.append("--" + name.replace("_", "-"))
            for name in ("endpoint", "output"):
                value = getattr(resume_args, name)
                if value is not None:
                    forwarded.extend(["--" + name, str(value)])
            return run_workflow(workflow, forwarded)
        args = _parser(family, action).parse_intermixed_args(argv)
        if not 1 <= args.limit <= 500 or args.offset < 0:
            raise client_error("INVALID_PARAMETER", "limit must be 1..500 and offset nonnegative.")
        timeout = getattr(args, "wait_timeout", 0)
        if not math.isfinite(timeout) or timeout < 0:
            raise client_error("INVALID_PARAMETER", "wait-timeout must be finite and nonnegative.")
        request = None
        if family == "jobs" and action == "retry":
            JobRetryRequest(idempotency_key=args.idempotency_key)
        if family == "analysis":
            if action == "compare":
                request = AnalysisCompareRequest(
                    left={"job_id": args.left_job, "artifact_id": args.left_artifact},
                    right={"job_id": args.right_job, "artifact_id": args.right_artifact},
                )
            else:
                model = AnalysisExportParameters if action == "export" else AnalysisSelectionRequest
                request = model(
                    job_id=args.job,
                    artifact_id=args.artifact,
                    tags=args.tag,
                    clip_ids=args.clip_id,
                    include_errors=args.include_errors,
                    metric_ranges=_document(args.metric_ranges) if args.metric_ranges else {},
                    subset_size=args.subset_size,
                    limit=args.limit,
                    offset=args.offset,
                    **({"format": args.format} if action == "export" else {}),
                )
            if action == "export":
                JobRetryRequest(idempotency_key=args.idempotency_key or "automatic")
                if args.output:
                    args.output = args.output.expanduser().absolute()
                    if args.output.exists() and not args.output.is_dir():
                        raise client_error("INVALID_OUTPUT", "--output must be a directory.")
                receipt_path = (
                    args.receipt or Path(".hhtools-client/runs") / (uuid.uuid4().hex + ".json")
                ).absolute()
                if receipt_path.exists():
                    raise client_error("OUTPUT_EXISTS", "Receipt exists; use hhtools runs resume.")
        if family == "runs":
            document = _runs(action, args)
        else:
            client = (
                RuntimeClient(args.endpoint, token=os.environ.get(args.token_env))
                if args.endpoint
                else connect_or_start(args.workspace)
            )
            identity = client.connect()
            if family == "jobs":
                document = _job(client, action, args, output)
            elif action != "export":
                document = client.call(
                    f"hhtools_runtime_{action}_analysis",
                    {"request": request.model_dump(mode="json")},
                )
            else:
                plan = client.call(
                    "hhtools_analysis_export_preflight",
                    {"request": request.model_dump(mode="json")},
                )
                receipt = {
                    "version": 1,
                    "workflow": "analysis-export",
                    "endpoint": client.endpoint,
                    "runtime_id": identity["runtime_id"],
                    "workspace_id": identity["workspace_id"],
                    "plan_id": plan["plan_id"],
                    "idempotency_key": args.idempotency_key or uuid.uuid4().hex,
                    "output": str(args.output.absolute()) if args.output else None,
                }
                _save(receipt_path, receipt, create=True)
                args.presentation = output
                document, code = _complete(client, "analysis-export", args, receipt, receipt_path)
                output.emit(document)
                return code
        output.emit(document)
        job = document.get("job", {})
        return (
            1
            if job.get("state") in {"failed", "cancelled"}
            or job.get("outcome") in {"partial", "rejected"}
            else 0
        )
    except SystemExit as error:
        return error.code
    except RuntimeClientError as error:
        document = error.api_error.model_dump(mode="json")
    except ValidationError as error:
        document = client_error(
            "INVALID_PARAMETER", "Invalid command parameters."
        ).api_error.model_dump(mode="json")
        document["details"] = validation_details(error.errors())
    except (OSError, ValueError, KeyError, TypeError):
        document = client_error(
            "INVALID_PARAMETER", "Could not read the command input or recovery file."
        ).api_error.model_dump(mode="json")
    except KeyboardInterrupt:
        document = client_error(
            "CLIENT_INTERRUPTED", "Stopped waiting; Runtime jobs are retained."
        ).api_error.model_dump(mode="json")
    if receipt_path and receipt_path.is_file():
        document["details"]["receipt"] = str(receipt_path)
    output.emit(document)
    return 130 if document["code"] == "CLIENT_INTERRUPTED" else 2
