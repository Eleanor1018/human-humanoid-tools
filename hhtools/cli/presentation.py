"""Terminal summaries and progress with a quiet, strict JSON mode for pipelines."""

import json
import sys
import time


class Output:
    def __init__(self, *, json_mode=False, human=False, quiet=False):
        self.json = json_mode or (not human and not sys.stdout.isatty())
        self.quiet = quiet or self.json
        self._last = None
        self._updated = 0.0

    def stage(self, message):
        if not self.quiet and message != self._last:
            print(message, file=sys.stderr, flush=True)
            self._last = message

    def transfer(self, stage):
        self.stage(stage)

        def update(done, total):
            now = time.monotonic()
            if done != total and now - self._updated < 0.5:
                return
            self._updated = now
            percent = done / total if total else 1
            self.stage(f"{stage}: {percent:.0%} ({done:,}/{total:,} bytes)")

        return update

    def job(self, job):
        progress = job.get("progress", {})
        self.stage(
            f"{job['job_id']}: {job['state']} {progress.get('phase', '')} "
            f"{progress.get('fraction', 0):.0%}"
        )

    def emit(self, document):
        if self.json:
            print(json.dumps(document, ensure_ascii=False, allow_nan=False))
            return
        if "code" in document:
            print(f"{document['code']}: {document.get('message', '')}", file=sys.stderr)
            details = document.get("details", {})
            for field in details.get("fields", []):
                path = field.get("path", [])
                print(
                    f"  {'.'.join(map(str, path)) if isinstance(path, list) else path}: "
                    f"{field.get('type', 'invalid')}",
                    file=sys.stderr,
                )
            if details.get("receipt"):
                print(f"Resume: {details['receipt']}", file=sys.stderr)
            return
        if "preflight" in document:
            preflight = document["preflight"]
            print(f"Preflight: {preflight.get('status', 'not ready')}")
            error = preflight.get("error")
            if error:
                self.emit(error)
            for action in preflight.get("required_actions", []):
                print(f"Next: {action['action']} {action.get('message') or ''}")
        if "job" in document:
            job = document["job"]
            print(
                f"{document.get('workflow', 'Job')}: {job['state']}"
                + (f" ({job['outcome']})" if job.get("outcome") else "")
            )
            print(f"Job: {job['job_id']}")
            if document.get("wait_timed_out"):
                print("Wait limit reached; the job continues in the Runtime.")
            if job.get("error"):
                self.emit(job["error"])
        for key in ("jobs", "runs", "clips", "artifacts"):
            if key in document:
                rows = document[key]
                print(f"{key.title()}: {document.get('total', len(rows))}")
                for row in rows:
                    label = (
                        row.get("job_id")
                        or row.get("receipt")
                        or row.get("clip_id")
                        or row.get("artifact_id")
                    )
                    print(
                        f"  {label}  {row.get('state', '')} "
                        f"{row.get('workflow', row.get('kind', ''))}"
                    )
        if "metrics" in document:
            print(
                f"Compared {document['left_count']} left and {document['right_count']} right clips"
            )
            for name, values in document["metrics"].items():
                print(
                    f"  {name}: {values['left_mean']} -> {values['right_mean']} "
                    f"(delta {values['delta']})"
                )
        if document.get("receipt"):
            print(f"Receipt: {document['receipt']}")
        for item in document.get("downloads", []):
            print(f"Downloaded: {item['path']}")
