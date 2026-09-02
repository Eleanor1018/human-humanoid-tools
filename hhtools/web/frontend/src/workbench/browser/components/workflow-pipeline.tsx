import { useMemo, useState } from "react";

import {
  PipelineNav,
  type PipelineNode,
} from "@/components/ui/pipeline-nav";
import { useLocaleText } from "@/hooks/use-locale-text";
import { useWindowEvent } from "@/hooks/use-window-event";
import { windowEventBus } from "@/platform/events/browser/window-event-bus";
import type {
  WorkflowId,
  WorkflowNodeStatus,
} from "@/runtime/types";
import type { WorkspaceLocale } from "@/workbench/common/workspace";

const labels: Record<WorkflowId, Record<string, readonly [string, string]>> = {
  h2r: {
    motion: ["Motion", "动作"],
    robot: ["Robot", "机器人"],
    calibration: ["Calibration", "标定"],
    solver: ["Solver", "求解"],
    result: ["Result", "结果"],
  },
  r2r: {
    source: ["Source robot", "源机器人"],
    trajectory: ["Source trajectory", "源轨迹"],
    target: ["Target robot", "目标机器人"],
    calibration: ["Calibration", "标定"],
    result: ["Result", "结果"],
  },
};

const targets: Record<WorkflowId, Record<string, string>> = {
  h2r: { calibration: "h2r-step-calibration", result: "h2r-step-result" },
  r2r: {
    source: "r2r-step-source",
    trajectory: "r2r-step-trajectory",
    target: "r2r-step-target",
    calibration: "r2r-step-calibration",
    result: "r2r-step-result",
  },
};

function defaultNodes(
  workflow: WorkflowId,
  text: ReturnType<typeof useLocaleText>,
): WorkflowNodeStatus[] {
  if (workflow === "h2r") {
    return [
      {
        id: "motion",
        label: text("Motion", "动作"),
        state: "missing",
        detail: text("Not selected", "未选择"),
        panel: "motion",
      },
      {
        id: "robot",
        label: text("Robot", "机器人"),
        state: "missing",
        detail: text("Not selected", "未选择"),
        panel: "robot-assets",
      },
      {
        id: "calibration",
        label: text("Calibration", "标定"),
        state: "missing",
        detail: text("Waiting for input", "等待输入"),
        panel: "h2r",
      },
      {
        id: "result",
        label: text("Result", "结果"),
        state: "missing",
        detail: text("No result yet", "尚无结果"),
        panel: "h2r",
      },
    ];
  }
  return [
    {
      id: "source",
      label: text("Source robot", "源机器人"),
      state: "missing",
      detail: text("Not selected", "未选择"),
      panel: "r2r",
    },
    {
      id: "trajectory",
      label: text("Source trajectory", "源轨迹"),
      state: "missing",
      detail: text("Not uploaded", "未上传"),
      panel: "r2r",
    },
    {
      id: "target",
      label: text("Target robot", "目标机器人"),
      state: "missing",
      detail: text("Not selected", "未选择"),
      panel: "r2r",
    },
    {
      id: "calibration",
      label: text("Calibration", "标定"),
      state: "missing",
      detail: text("Waiting for input", "等待输入"),
      panel: "r2r",
    },
    {
      id: "result",
      label: text("Result", "结果"),
      state: "missing",
      detail: text("No result yet", "尚无结果"),
      panel: "r2r",
    },
  ];
}

export function WorkflowPipeline({
  workflow,
  locale,
}: {
  workflow: WorkflowId;
  locale: WorkspaceLocale;
}) {
  const text = useLocaleText(locale);
  const [nodes, setNodes] = useState(() => defaultNodes(workflow, text));
  useWindowEvent("hhtools:workflow-state", (event) => {
    if (event.detail.workflow === workflow) setNodes(event.detail.nodes);
  });

  const pipelineNodes = useMemo<PipelineNode[]>(
    () =>
      nodes
        .filter((node) => workflow !== "h2r" || node.id !== "solver")
        .map((node) => ({
          ...node,
          label: labels[workflow][node.id]
            ? text(labels[workflow][node.id][0], labels[workflow][node.id][1])
            : node.label,
          activate: () => {
            windowEventBus.emit("hhtools:panel-request", node.panel);
            const targetId = targets[workflow][node.id];
            if (!targetId) return;
            requestAnimationFrame(() => {
              const target = document.getElementById(targetId);
              if (target instanceof HTMLDetailsElement) target.open = true;
              target?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          },
        })),
    [nodes, text, workflow],
  );

  return (
    <PipelineNav
      label={
        workflow === "h2r"
          ? text("Human to Robot pipeline", "人体到机器人流程")
          : text("Robot to Robot pipeline", "机器人到机器人流程")
      }
      className={`workflow-${workflow}-pipeline`}
      nodes={pipelineNodes}
    />
  );
}
