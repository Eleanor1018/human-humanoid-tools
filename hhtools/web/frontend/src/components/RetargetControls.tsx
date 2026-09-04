import { Field, fieldClass } from "@/components/Field";
import { Button } from "@/components/ui/button";

export function RetargetControls({
  fpsPlaceholder,
  disabledReason,
}: {
  fpsPlaceholder: string;
  disabledReason: string;
}) {
  return (
    <div className="grid gap-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Solver">
          <select className={fieldClass} defaultValue="newton" disabled>
            <option value="newton">Newton IK</option>
            <option value="interaction-mesh">Interaction-Mesh</option>
          </select>
        </Field>
        <Field label="Retarget FPS">
          <input className={fieldClass} placeholder={fpsPlaceholder} disabled />
        </Field>
      </div>
      <Button variant="primary" size="sm" disabled>
        Start Retarget
      </Button>
      <p className="text-xs leading-[1.4] text-muted-foreground">
        {disabledReason}
      </p>
    </div>
  );
}
