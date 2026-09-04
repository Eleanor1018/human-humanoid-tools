import { useState } from "react";

import { Field, fieldClass } from "@/components/Field";
import { InspectorPage } from "@/components/Inspector";
import { RobotPicker } from "@/components/RobotPicker";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { WorkflowStep } from "@/components/WorkflowSteps";

type BatchMode = "v2m" | "h2r" | "r2r";

const modes = [
  { id: "v2m", label: "V2M" },
  { id: "h2r", label: "H2R" },
  { id: "r2r", label: "R2R" },
] as const;

function InputSummary({ label, unit }: { label: string; unit: string }) {
  return (
    <div className="flex min-h-10 items-center justify-between border-b border-border-subtle text-[13px] font-semibold text-foreground">
      <span>{label}</span>
      <strong className="text-xs text-muted-foreground">0 {unit}</strong>
    </div>
  );
}

function BatchSettings({ step = 3 }: { step?: number }) {
  return (
    <WorkflowStep title={`${step}. Run settings`} defaultOpen>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Solver">
          <select className={fieldClass} defaultValue="newton" disabled>
            <option value="newton">Newton IK</option>
            <option value="interaction-mesh">Interaction-Mesh</option>
          </select>
        </Field>
        <Field label="Output format">
          <select className={fieldClass} defaultValue="pkl" disabled>
            <option value="pkl">PKL</option>
            <option value="csv">CSV</option>
          </select>
        </Field>
      </div>
    </WorkflowStep>
  );
}

function RunPanel({ label, hint }: { label: string; hint: string }) {
  return (
    <section className="grid gap-2.5 pt-4">
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Button variant="primary" size="sm" disabled>
        {label}
      </Button>
    </section>
  );
}

function HumanBatch() {
  return (
    <div>
      <InputSummary label="1. Inputs" unit="clips" />
      <WorkflowStep title="2. Target robot & compatibility" defaultOpen>
        <RobotPicker label="Select target robot" status="Not loaded" />
      </WorkflowStep>
      <BatchSettings />
      <RunPanel
        label="Start batch task"
        hint="Add motions and select a target robot first."
      />
    </div>
  );
}

function RobotBatch() {
  return (
    <div>
      <InputSummary label="1. Source trajectories" unit="trajectories" />
      <WorkflowStep title="2. Source robot" defaultOpen>
        <RobotPicker label="Select source robot" status="Not loaded" />
      </WorkflowStep>
      <WorkflowStep title="3. Target robot" defaultOpen>
        <RobotPicker label="Select target robot" status="Not loaded" />
      </WorkflowStep>
      <BatchSettings step={4} />
      <RunPanel
        label="Start R2R batch task"
        hint="Add trajectories and load both robots first."
      />
    </div>
  );
}

function VideoBatch() {
  return (
    <div>
      <InputSummary label="1. Videos" unit="videos" />
      <WorkflowStep title="2. Environment" defaultOpen>
        <div className="grid gap-2.5">
          <select className={fieldClass} defaultValue="official" disabled>
            <option value="official">GVHMR Official</option>
          </select>
          <Button size="sm" disabled>
            Confirm environment
          </Button>
        </div>
      </WorkflowStep>
      <WorkflowStep title="3. Generate motions" defaultOpen>
        <div className="grid gap-2.5">
          <label className="flex min-h-8 items-center justify-between gap-3 text-xs font-medium text-foreground">
            Static camera
            <input type="checkbox" defaultChecked disabled className="size-4 accent-primary" />
          </label>
          <input className={fieldClass} placeholder="Auto focal length" disabled />
          <Button variant="primary" size="sm" disabled>
            Start V2M batch
          </Button>
        </div>
      </WorkflowStep>
    </div>
  );
}

const modeViews: Record<BatchMode, () => React.JSX.Element> = {
  v2m: VideoBatch,
  h2r: HumanBatch,
  r2r: RobotBatch,
};

export function BatchView() {
  const [mode, setMode] = useState<BatchMode>("h2r");
  const ActiveMode = modeViews[mode];

  return (
    <InspectorPage title="Batch">
      <SegmentedControl
        label="Batch workflow"
        items={modes}
        value={mode}
        onValueChange={setMode}
      />
      <ActiveMode />
    </InspectorPage>
  );
}
