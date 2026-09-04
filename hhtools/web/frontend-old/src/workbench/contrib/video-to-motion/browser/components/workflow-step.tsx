import { useEffect, type ReactNode, type RefObject } from "react";

interface WorkflowStepProps {
  readonly id: string;
  readonly title: string;
  readonly detailsRef: RefObject<HTMLDetailsElement | null>;
  readonly initiallyOpen?: boolean;
  readonly children: ReactNode;
}

/** Shared disclosure shell; each feature step owns only its body controls. */
export function WorkflowStep({
  id,
  title,
  detailsRef,
  initiallyOpen = false,
  children,
}: WorkflowStepProps) {
  useEffect(() => {
    // Apply only when this disclosure mounts. Keeping `open` uncontrolled lets
    // user and pipeline navigation choices survive later progress renders.
    if (initiallyOpen && detailsRef.current) detailsRef.current.open = true;
  }, [detailsRef, initiallyOpen]);

  return (
    <details
      ref={detailsRef}
      id={id}
      className="video-workflow-step"
    >
      <summary className="video-workflow-step-summary">
        <span>{title}</span>
      </summary>
      <div className="video-workflow-step-body">{children}</div>
    </details>
  );
}
