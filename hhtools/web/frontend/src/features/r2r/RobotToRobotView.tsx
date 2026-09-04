import { Field, fieldClass } from "@/components/Field";
import { InspectorPage } from "@/components/Inspector";
import { RetargetControls } from "@/components/RetargetControls";
import { RobotPicker } from "@/components/RobotPicker";
import { Button } from "@/components/ui/button";
import { WorkflowPipeline, WorkflowStep } from "@/components/WorkflowSteps";

const pipeline = [
  "Source Robot",
  "Source Trajectory",
  "Target Robot",
  "Calibration",
  "Result",
];

export function RobotToRobotView() {
  return (
    <InspectorPage title="Robot → Robot">
      <WorkflowPipeline label="Robot to Robot pipeline" steps={pipeline} />
      <div className="flex shrink-0 flex-col">
        <WorkflowStep title="1. Source robot" status="Not loaded" defaultOpen>
          <RobotPicker
            label="Select source robot"
            status="No source robot loaded."
          />
        </WorkflowStep>

        <WorkflowStep title="2. Source trajectory" status="Not loaded">
          <div className="grid gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                Not loaded
              </span>
              <Button size="sm" disabled>
                Select trajectory
              </Button>
            </div>
            <Field label="Source trajectory FPS">
              <input className={fieldClass} defaultValue="50" disabled />
            </Field>
            <p className="text-xs leading-[1.4] text-muted-foreground">
              Load the source robot, then select a trajectory.
            </p>
          </div>
        </WorkflowStep>

        <WorkflowStep title="3. Target robot" status="Not loaded">
          <RobotPicker
            label="Select target robot"
            status="No target robot loaded."
          />
        </WorkflowStep>

        <WorkflowStep title="4. Calibration" status="Not calibrated">
          <div className="grid gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-foreground">Calibration</span>
              <Button size="sm" disabled>
                Calibrate
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Target robot + source robot
            </p>
          </div>
        </WorkflowStep>

        <WorkflowStep title="5. Result" status="Not ready">
          <RetargetControls
            fpsPlaceholder="Trajectory FPS"
            disabledReason="Select the source robot, trajectory, and target robot first."
          />
        </WorkflowStep>
      </div>
    </InspectorPage>
  );
}
