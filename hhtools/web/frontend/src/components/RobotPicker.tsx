import { fieldClass } from "@/components/Field";
import { Button } from "@/components/ui/button";

export function RobotPicker({
  label,
  status,
}: {
  label: string;
  status: string;
}) {
  return (
    <div className="grid gap-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select
          className={fieldClass}
          aria-label={label}
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
      <p className="text-xs text-muted-foreground">{status}</p>
    </div>
  );
}
