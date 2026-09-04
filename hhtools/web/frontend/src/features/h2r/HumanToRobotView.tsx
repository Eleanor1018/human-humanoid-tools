import { Field, fieldClass } from "@/components/Field";
import { InspectorPage } from "@/components/Inspector";
import { RetargetControls } from "@/components/RetargetControls";
import { RobotPicker } from "@/components/RobotPicker";
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
          <RobotPicker label="Select target robot" status="Not loaded" />
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
          <RetargetControls
            fpsPlaceholder="Original FPS"
            disabledReason="Select a motion and robot first."
          />
        </WorkflowStep>
      </div>
    </InspectorPage>
  );
}
