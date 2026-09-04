import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

interface WorkflowPipelineProps {
  label: string;
  steps: readonly string[];
  activeIndex?: number;
}

export function WorkflowPipeline({
  label,
  steps,
  activeIndex = 0,
}: WorkflowPipelineProps) {
  return (
    <ol
      className="grid min-h-[54px] shrink-0 gap-0"
      style={
        { gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` } as CSSProperties
      }
      aria-label={label}
    >
      {steps.map((step, index) => (
        <li
          key={step}
          className="relative flex min-w-0 flex-col items-center gap-1.5 text-center"
          aria-current={index === activeIndex ? "step" : undefined}
        >
          {index > 0 && (
            <span
              className="absolute top-[5px] right-1/2 h-px w-full bg-border-subtle"
              aria-hidden="true"
            />
          )}
          <span
            className={cn(
              "relative z-[1] size-2.5 rounded-full border-2 border-surface bg-border",
              index === activeIndex && "bg-primary",
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              "max-w-full px-1 text-[11px] leading-tight text-muted-foreground",
              index === activeIndex && "font-semibold text-foreground",
            )}
          >
            {step}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface WorkflowStepProps {
  title: string;
  status?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function WorkflowStep({
  title,
  status,
  defaultOpen = false,
  children,
}: WorkflowStepProps) {
  return (
    <details className="group border-b border-border-subtle" open={defaultOpen || undefined}>
      <summary className="flex min-h-[42px] cursor-pointer list-none items-center gap-2 text-[13px] font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {status && (
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
            {status}
          </span>
        )}
        <span
          className="size-4 shrink-0 bg-muted-foreground transition-transform [mask:url(/icons/common/chevron-down.svg)_center/contain_no-repeat] [-webkit-mask:url(/icons/common/chevron-down.svg)_center/contain_no-repeat] group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="pt-0.5 pb-4">{children}</div>
    </details>
  );
}
