"""Shared report selection, dataset subsets, comparison, and portable exports."""

from __future__ import annotations

import csv
import io
import statistics

from hhtools.contracts.workflows import AnalysisSelectionRequest


class AnalysisReports:
    def __init__(self, reports):
        self.reports = reports

    def selected(self, request: AnalysisSelectionRequest, *, report=None):
        report = report or self.reports.analysis(request.job_id, request.artifact_id)
        selected = []
        for clip in report["clips"]:
            if clip.get("error") and not request.include_errors:
                continue
            if not set(request.tags) <= set(clip.get("tags", [])):
                continue
            if request.clip_ids and clip["clip_id"] not in request.clip_ids:
                continue
            valid = True
            for key, (minimum, maximum) in request.metric_ranges.items():
                value = clip.get("metrics", {}).get(key)
                if (
                    not isinstance(value, (int, float))
                    or (minimum is not None and value < minimum)
                    or (maximum is not None and value > maximum)
                ):
                    valid = False
                    break
            if valid:
                selected.append(clip)
        if request.subset_size is not None:
            from hhtools.analysis.dataset_analysis import compute_subset

            chosen = set(
                compute_subset(selected, min(request.subset_size, len(selected)), request.alpha)
            )
            selected = [clip for clip in selected if clip["clip_id"] in chosen]
        return selected

    def select(self, request):
        selected = self.selected(request)
        return {
            "job_id": request.job_id,
            "artifact_id": request.artifact_id,
            "total": len(selected),
            "clips": selected[request.offset : request.offset + request.limit],
            "offset": request.offset,
            "limit": request.limit,
        }

    def compare(self, left, right):
        from hhtools.services.runtime_control import RuntimeServiceError

        left_report = self.reports.analysis(left.job_id, left.artifact_id)
        right_report = self.reports.analysis(right.job_id, right.artifact_id)
        definitions = [
            (report.get("evaluator"), report.get("parameters", {}).get("metric_config"))
            for report in (left_report, right_report)
        ]
        if definitions[0] != definitions[1]:
            raise RuntimeServiceError(
                "EVALUATION_INCOMPATIBLE",
                "Reports use different metric definitions or configurations.",
            )
        a = self.selected(left, report=left_report)
        b = self.selected(right, report=right_report)
        keys = sorted(
            {
                key
                for clip in a + b
                for key, value in clip.get("metrics", {}).items()
                if isinstance(value, (int, float))
            }
        )
        metrics = {}
        for key in keys:
            values_a = [
                clip["metrics"][key]
                for clip in a
                if isinstance(clip.get("metrics", {}).get(key), (int, float))
            ]
            values_b = [
                clip["metrics"][key]
                for clip in b
                if isinstance(clip.get("metrics", {}).get(key), (int, float))
            ]
            mean_a = statistics.mean(values_a) if values_a else None
            mean_b = statistics.mean(values_b) if values_b else None
            metrics[key] = {
                "left_mean": mean_a,
                "right_mean": mean_b,
                "delta": mean_b - mean_a if mean_a is not None and mean_b is not None else None,
            }
        return {"left_count": len(a), "right_count": len(b), "metrics": metrics}

    @staticmethod
    def csv(clips):
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(
            stream, fieldnames=["clip_id", "asset_id", "relative_path", "dataset", "source_kind"]
        )
        writer.writeheader()
        for clip in clips:
            row = {key: str(clip.get(key, "")) for key in writer.fieldnames}
            # Keep spreadsheet exports inert even when labels came from asset metadata.
            writer.writerow(
                {
                    key: "'" + value if value.startswith(("=", "+", "-", "@")) else value
                    for key, value in row.items()
                }
            )
        return stream.getvalue().encode("utf-8")
