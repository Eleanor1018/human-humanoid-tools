import { cn } from "@/lib/utils";
import type { WorkflowNodeState } from "@/runtime/types";

export interface PipelineNode {
  id: string;
  label: string;
  detail: string;
  state: WorkflowNodeState;
  activate(): void;
}

interface PipelineNavProps {
  label: string;
  className?: string;
  nodes: PipelineNode[];
}

/** Shared workbench pipeline navigation used by H2R, R2R, video, and analysis. */
export function PipelineNav({ label, className, nodes }: PipelineNavProps) {
  return (
    <section className={cn("workflow-pipeline", className)} aria-label={label}>
      <ol className="workflow-pipeline-nodes">
        {nodes.map((node) => (
          <li key={node.id} className="workflow-pipeline-node">
            <button
              type="button"
              className={cn("workflow-node-button", `state-${node.state}`)}
              title={node.detail}
              onClick={node.activate}
            >
              <span className="workflow-node-dot" aria-hidden="true" />
              <span className="workflow-node-label">{node.label}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
