import { cn } from "@/lib/utils";

/** Visual state only; workflow ownership remains with the calling feature. */
export type PipelineNodeState =
  | "missing"
  | "validating"
  | "ready"
  | "running"
  | "completed"
  | "warning"
  | "failed";

export interface PipelineNode {
  id: string;
  label: string;
  detail: string;
  state: PipelineNodeState;
  activate(): void;
}

interface PipelineNavProps {
  label: string;
  className?: string;
  nodes: PipelineNode[];
}

/** Shared presentational pipeline navigation with no feature or shell owner. */
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
