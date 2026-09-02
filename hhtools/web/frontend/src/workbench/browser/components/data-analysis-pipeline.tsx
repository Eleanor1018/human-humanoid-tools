import { useMemo, useState } from "react";

import { useLocaleText } from "@/hooks/use-locale-text";
import { useWindowEvent } from "@/hooks/use-window-event";
import type { DataAnalysisStateDetail, WorkspaceLocale } from "@/runtime/types";
import { PipelineNav, type PipelineNode } from "./pipeline-nav";

const initialState: DataAnalysisStateDetail = {
  dataKind: "unknown",
  clipCount: 0,
  stage: "idle",
  progress: 0,
  message: "",
  hasResults: false,
};

export function DataAnalysisPipeline({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  const [state, setState] = useState(initialState);
  useWindowEvent("hhtools:data-analysis-state", (event) =>
    setState(event.detail),
  );

  const nodes = useMemo<PipelineNode[]>(() => {
    const hasSource = state.clipCount > 0;
    const processing = state.stage === "uploading" || state.stage === "running";
    const kindLabel =
      state.dataKind === "robot"
        ? text("Robot", "机器人")
        : state.dataKind === "human"
          ? text("Motion", "动作")
          : text("No data", "未选择");
    const open =
      (target: string): (() => void) =>
      () =>
        requestAnimationFrame(() => {
          const element = document.getElementById(target);
          if (element instanceof HTMLDetailsElement) element.open = true;
          element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
    return [
      {
        id: "source",
        label: text("Select Data", "选择数据"),
        detail: hasSource
          ? `${kindLabel} · ${state.clipCount} clips`
          : kindLabel,
        state:
          state.stage === "uploading"
            ? "running"
            : hasSource
              ? "completed"
              : "ready",
        activate: open("dv-step-source"),
      },
      {
        id: "configure",
        label: text("Configure", "分析配置"),
        detail: text("Embedding and cache", "特征与缓存设置"),
        state:
          state.stage === "running" || state.stage === "completed"
            ? "completed"
            : hasSource
              ? "ready"
              : "missing",
        activate: open("dv-step-configure"),
      },
      {
        id: "analyze",
        label: text("Analyze", "运行分析"),
        detail: processing
          ? `${Math.round(state.progress * 100)}%`
          : state.stage === "completed"
            ? text("Completed", "已完成")
            : state.stage === "failed"
              ? text("Failed", "失败")
              : text("Not started", "未开始"),
        state:
          state.stage === "running"
            ? "running"
            : state.stage === "completed"
              ? "completed"
              : state.stage === "failed"
                ? "failed"
                : hasSource
                  ? "ready"
                  : "missing",
        activate: open("dv-step-analyze"),
      },
      {
        id: "results",
        label: text("Results", "分析结果"),
        detail: state.hasResults
          ? text("Ready", "可查看")
          : text("No results", "暂无结果"),
        state: state.hasResults ? "completed" : "missing",
        activate: open("dv-step-results"),
      },
    ];
  }, [state, text]);

  return (
    <PipelineNav
      label={text("Data Analysis Pipeline", "数据分析流程")}
      className="data-analysis-pipeline"
      nodes={nodes}
    />
  );
}
