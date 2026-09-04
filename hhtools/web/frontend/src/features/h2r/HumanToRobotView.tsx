import { Field, fieldClass } from "@/components/Field";
import { InspectorPage } from "@/components/Inspector";
import { Button } from "@/components/ui/button";
import { WorkflowPipeline, WorkflowStep } from "@/components/WorkflowSteps";

const pipeline = ["Motion", "Robot", "Calibration", "Result"];

export function HumanToRobotView() {
  return (
    <InspectorPage title="Human → Robot">
      <WorkflowPipeline label="Human to Robot pipeline" steps={pipeline} />
      <div className="flex shrink-0 flex-col">
        <WorkflowStep title="1. Motion" status="Not loaded" defaultOpen>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              Not loaded
            </span>
            <Button size="sm" disabled>
              Select motion
            </Button>
          </div>
        </WorkflowStep>

        <WorkflowStep title="2. Target robot" status="Not loaded">
          <div className="grid gap-2.5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <select
                className={fieldClass}
                aria-label="Select target robot"
                defaultValue=""
                disabled
              >
                <option value="">No robots available</option>
              </select>
              <Button size="sm" disabled>
                Import robot
              </Button>
            </div>
            <Button variant="primary" size="sm" disabled>
              Load robot
            </Button>
            <p className="text-xs text-muted-foreground">Not loaded</p>
          </div>
        </WorkflowStep>

        <WorkflowStep title="3. Calibration" status="Not calibrated">
          <div className="grid gap-2.5">
            <Field label="Reference pose">
              <select className={fieldClass} defaultValue="" disabled>
                <option value="">—</option>
              </select>
            </Field>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-foreground">Calibration</span>
              <Button size="sm" disabled>
                Calibrate
              </Button>
            </div>
          </div>
        </WorkflowStep>

        <WorkflowStep title="4. Result" status="Not ready">
          <div className="grid gap-2.5">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Solver">
                <select className={fieldClass} defaultValue="newton" disabled>
                  <option value="newton">Newton IK</option>
                  <option value="interaction-mesh">Interaction-Mesh</option>
                </select>
              </Field>
              <Field label="Retarget FPS">
                <input className={fieldClass} placeholder="Original FPS" disabled />
              </Field>
            </div>
            <Button variant="primary" size="sm" disabled>
              Start Retarget
            </Button>
            <p className="text-xs leading-[1.4] text-muted-foreground">
              Select a motion and robot first.
            </p>
          </div>
        </WorkflowStep>
      </div>
    </InspectorPage>
  );
}
