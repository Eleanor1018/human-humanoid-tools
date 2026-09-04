import { ChevronLeft, ChevronRight } from "lucide-react";

import type { WorkspaceLocale } from "@/workbench/common/workspace";
import { cn } from "@/lib/utils";

interface WorkspaceDrawerHandleProps {
  side: "left" | "right";
  expanded: boolean;
  locale: WorkspaceLocale;
  onToggle(): void;
}

export function WorkspaceDrawerHandle({
  side,
  expanded,
  locale,
  onToggle,
}: WorkspaceDrawerHandleProps) {
  const controls = side === "left" ? "sidebar" : "inspector";
  const elementId = side === "left" ? "toggle-sidebar" : "toggle-inspector";
  const pointsLeft = side === "left" ? expanded : !expanded;
  const expanding = !expanded;
  const label =
    locale === "zh-CN"
      ? side === "left"
        ? expanding
          ? "展开左侧导航"
          : "折叠左侧导航"
        : expanding
          ? "展开右侧控制面板"
          : "折叠右侧控制面板"
      : side === "left"
        ? expanding
          ? "Expand left navigation"
          : "Collapse left navigation"
        : expanding
          ? "Expand right inspector"
          : "Collapse right inspector";
  const Icon = pointsLeft ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      className={cn("workspace-drawer-handle", side)}
      id={elementId}
      data-state={expanded ? "expanded" : "collapsed"}
      title={label}
      aria-label={label}
      aria-controls={controls}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <Icon className="workspace-drawer-icon" aria-hidden="true" />
    </button>
  );
}
