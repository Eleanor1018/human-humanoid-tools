export type WorkflowPipelineState = "complete" | "active" | "pending";

export function workflowPipelineState(
  index: number,
  activeIndex: number,
  completedIndex: number,
): WorkflowPipelineState {
  if (index <= completedIndex) return "complete";
  if (index === activeIndex) return "active";
  return "pending";
}
