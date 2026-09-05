import { useEffect, useMemo, useRef, useState } from "react";

import type { CalibrationDisplayOptions } from "@/stage/calibrationDisplay";
import { updateCalibrationDisplay } from "@/stage/calibrationDisplay";
import { prepareReferenceSkeleton } from "@/stage/referenceSkeleton";
import type { StageMotionPayload, StageRobotPayload } from "@/stage/types";

import { ValidationSummary } from "./ValidationSummary";
import { calibrationValidationFacts } from "./validationFacts";
import { Button } from "./ui/button";
import {
  angleForDisplay,
  angleFromDisplay,
  calibrationJointMatches,
  clampCalibrationValue,
  formatCalibrationAngle,
  isNearCalibrationLimit,
  normalizeCalibrationValues,
  resolveCalibrationJointLimits,
  setCalibrationJointValue,
  zeroCalibrationRegion,
  zeroCalibrationValues,
  type CalibrationAngleUnit,
  type CalibrationJointLimit,
  type CalibrationJointRegion,
  type ResolvedCalibrationJointLimit,
} from "./calibrationEditorState";

interface CalibrationEditorProps {
  readonly limits: readonly CalibrationJointLimit[];
  readonly value: Readonly<Record<string, number>>;
  readonly baseline: Readonly<Record<string, number>>;
  readonly hasSavedBaseline: boolean;
  readonly reference: StageMotionPayload;
  readonly robot: StageRobotPayload;
  readonly display: CalibrationDisplayOptions;
  readonly angleUnit?: CalibrationAngleUnit;
  readonly selectedJoint?: string | null;
  readonly disabled?: boolean;
  readonly saving?: boolean;
  readonly onChange: (value: Record<string, number>) => void;
  readonly onDisplayChange: (value: CalibrationDisplayOptions) => void;
  readonly onAngleUnitChange?: (unit: CalibrationAngleUnit) => void;
  readonly onJointSelected?: (name: string) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}

const numberClass =
  "h-7 w-[76px] rounded-md border border-border bg-surface px-2 text-right text-[11px] tabular-nums text-foreground outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-50";

type RegionFilter = CalibrationJointRegion | "all";
type ComparisonMode = "current" | "saved" | "zero";

const regions: readonly { value: RegionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "torso", label: "Torso" },
  { value: "left-arm", label: "L arm" },
  { value: "right-arm", label: "R arm" },
  { value: "left-leg", label: "L leg" },
  { value: "right-leg", label: "R leg" },
  { value: "head", label: "Head" },
  { value: "hands", label: "Hands" },
];

function CalibrationJointRow({
  limit,
  value,
  unit,
  selected,
  disabled,
  onSelect,
  onChange,
}: {
  readonly limit: ResolvedCalibrationJointLimit;
  readonly value: number;
  readonly unit: CalibrationAngleUnit;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
  readonly onChange: (valueRad: number) => void;
}) {
  const editing = useRef(false);
  const [numberValue, setNumberValue] = useState(() =>
    limit.type === "prismatic" ? value.toFixed(3) : formatCalibrationAngle(value, unit),
  );
  const nearLimit = isNearCalibrationLimit(value, limit);
  const linear = limit.type === "prismatic";
  const displayValue = (next: number) =>
    linear ? next : angleForDisplay(next, unit);
  const storedValue = (next: number) =>
    linear ? next : angleFromDisplay(next, unit);
  const formatValue = (next: number) =>
    linear ? next.toFixed(3) : formatCalibrationAngle(next, unit);

  useEffect(() => {
    if (!editing.current) setNumberValue(formatValue(value));
  }, [linear, unit, value]);

  const commit = (raw: string) => {
    const parsed = raw.trim() ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      setNumberValue(formatValue(value));
      return;
    }
    const next = clampCalibrationValue(storedValue(parsed), limit);
    onChange(next);
    setNumberValue(formatValue(next));
  };

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_minmax(72px,1fr)_76px] items-center gap-2 rounded-sm px-1 py-0.5 text-[11px] ${selected ? "bg-accent" : ""}`}
      onPointerDown={onSelect}
    >
      <span
        className={nearLimit ? "truncate text-[#c98413]" : "truncate text-muted-foreground"}
        title={limit.name}
      >
        {limit.name}
      </span>
      <input
        type="range"
        min={limit.lower}
        max={limit.upper}
        step="0.001"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-4 min-w-0 accent-primary"
        aria-label={`${limit.name} angle`}
      />
      <input
        type="number"
        min={displayValue(limit.lower)}
        max={displayValue(limit.upper)}
        step={!linear && unit === "deg" ? "0.1" : "0.001"}
        value={numberValue}
        disabled={disabled}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          setNumberValue(raw);
          const parsed = raw.trim() ? Number(raw) : Number.NaN;
          if (Number.isFinite(parsed)) onChange(storedValue(parsed));
        }}
        onBlur={(event) => {
          editing.current = false;
          commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={`${numberClass} ${nearLimit ? "border-[#c98413]/55" : ""}`}
        aria-label={`${limit.name} ${linear ? "metres" : unit === "deg" ? "degrees" : "radians"}`}
        title={linear ? "Translation in metres" : unit === "deg" ? "Degrees; stored in radians" : "Angle in radians"}
      />
    </div>
  );
}

/** Shared controlled editor for H2R and R2R calibration sessions. */
export function CalibrationEditor({
  limits,
  value,
  baseline,
  hasSavedBaseline,
  reference,
  robot,
  display,
  angleUnit: controlledAngleUnit,
  selectedJoint = null,
  disabled = false,
  saving = false,
  onChange,
  onDisplayChange,
  onAngleUnitChange,
  onJointSelected,
  onCancel,
  onSave,
}: CalibrationEditorProps) {
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState<RegionFilter>("all");
  const [localAngleUnit, setLocalAngleUnit] = useState<CalibrationAngleUnit>("rad");
  const unit = controlledAngleUnit ?? localAngleUnit;
  const publishAngleUnit = onAngleUnitChange ?? setLocalAngleUnit;
  const [comparison, setComparison] = useState<ComparisonMode>("current");
  const currentDraft = useRef(normalizeCalibrationValues(limits, value));
  const resolved = useMemo(
    () => resolveCalibrationJointLimits(limits, value),
    [limits, value],
  );
  const visibleLimits = useMemo(
    () => resolved.filter((limit) => calibrationJointMatches(limit.name, query, region)),
    [query, region, resolved],
  );
  const mappedLandmarks = useMemo(
    () => prepareReferenceSkeleton(reference, robot).mappings.length,
    [reference, robot],
  );
  const updateDisplay = (patch: Partial<CalibrationDisplayOptions>) => {
    onDisplayChange(updateCalibrationDisplay(display, patch));
  };
  const publishEdit = (next: Readonly<Record<string, number>>) => {
    const normalized = normalizeCalibrationValues(limits, next);
    currentDraft.current = normalized;
    setComparison("current");
    onChange(normalized);
  };
  const showComparison = (next: ComparisonMode) => {
    if (comparison === "current") {
      currentDraft.current = normalizeCalibrationValues(limits, value);
    }
    const target =
      next === "zero"
        ? zeroCalibrationValues(limits, value)
        : next === "saved"
          ? normalizeCalibrationValues(limits, baseline)
          : currentDraft.current;
    setComparison(next);
    onChange(target);
  };

  return (
    <div className="grid gap-2.5 rounded-md border border-border-subtle bg-background p-2.5">
      <div className="grid gap-1.5 border-b border-border-subtle pb-2.5 text-[11px]">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1.5">
          <input
            type="search"
            value={query}
            placeholder="Search joints"
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className="h-7 min-w-0 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground outline-none focus:border-primary"
            aria-label="Search calibration joints"
          />
          <span className="min-w-9 text-center tabular-nums text-muted-foreground">
            {visibleLimits.length}/{resolved.length}
          </span>
          <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border-subtle">
            {(["rad", "deg"] as const).map((option) => (
              <button
                key={option}
                type="button"
                disabled={disabled}
                aria-pressed={unit === option}
                onClick={() => publishAngleUnit(option)}
                className={`min-h-7 px-2 text-[10px] font-semibold ${
                  unit === option
                    ? "bg-accent text-accent-foreground"
                    : "bg-surface text-muted-foreground hover:bg-background"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Joint regions">
          {regions.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={region === option.value}
              onClick={() => setRegion(option.value)}
              className={`min-h-6 rounded-md border px-2 text-[10px] font-semibold ${
                region === option.value
                  ? "border-primary bg-accent text-accent-foreground"
                  : "border-border-subtle bg-surface text-muted-foreground hover:border-border"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
          <div
            className="grid grid-cols-3 overflow-hidden rounded-md border border-border-subtle"
            role="group"
            aria-label="Pose comparison"
          >
            {([
              ["current", "Current"],
              ["saved", "Saved"],
              ["zero", "URDF zero"],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                disabled={disabled || (mode === "saved" && !hasSavedBaseline)}
                aria-pressed={comparison === mode}
                onClick={() => showComparison(mode)}
                className={`min-h-7 min-w-0 truncate px-1.5 text-[10px] font-semibold ${
                  comparison === mode
                    ? "bg-accent text-accent-foreground"
                    : "bg-surface text-muted-foreground hover:bg-background disabled:opacity-40"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            disabled={disabled}
            className="min-h-7 px-2 text-[10px]"
            onClick={() =>
              publishEdit(zeroCalibrationRegion(limits, value, region))
            }
          >
            Zero region
          </Button>
        </div>
      </div>

      <div className="grid gap-2 border-b border-border-subtle pb-2.5 text-[11px] text-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="font-semibold text-muted-foreground">Stage display</span>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={display.mappedOnly}
              disabled={disabled}
              onChange={(event) => updateDisplay({ mappedOnly: event.currentTarget.checked })}
              className="size-3.5 accent-primary"
            />
            Mapped only
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={display.labels}
              disabled={disabled}
              onChange={(event) => updateDisplay({ labels: event.currentTarget.checked })}
              className="size-3.5 accent-primary"
            />
            Labels
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={display.mappingLines}
              disabled={disabled}
              onChange={(event) => updateDisplay({ mappingLines: event.currentTarget.checked })}
              className="size-3.5 accent-primary"
            />
            Link lines
          </label>
          <span className="ml-auto text-muted-foreground">
            {mappedLandmarks} mapped
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">
            <span className="flex justify-between gap-2">
              Reference
              <span className="tabular-nums text-muted-foreground">
                {Math.round(display.referenceOpacity * 100)}%
              </span>
            </span>
            <input
              type="range"
              min="0.15"
              max="1"
              step="0.05"
              value={display.referenceOpacity}
              disabled={disabled}
              onChange={(event) =>
                updateDisplay({ referenceOpacity: Number(event.currentTarget.value) })
              }
              className="h-4 w-full accent-primary"
            />
          </label>
          <label className="grid gap-1">
            <span className="flex justify-between gap-2">
              Robot
              <span className="tabular-nums text-muted-foreground">
                {Math.round(display.robotOpacity * 100)}%
              </span>
            </span>
            <input
              type="range"
              min="0.2"
              max="1"
              step="0.05"
              value={display.robotOpacity}
              disabled={disabled}
              onChange={(event) =>
                updateDisplay({ robotOpacity: Number(event.currentTarget.value) })
              }
              className="h-4 w-full accent-primary"
            />
          </label>
        </div>
      </div>

      <ValidationSummary
        items={calibrationValidationFacts(robot, limits, value)}
        label="Calibration validation"
      />

      <div className="grid max-h-64 gap-1.5 overflow-y-auto pr-1">
        {visibleLimits.map((limit) => (
          <CalibrationJointRow
            key={limit.name}
            limit={limit}
            value={value[limit.name] ?? 0}
            unit={unit}
            selected={selectedJoint === limit.name}
            disabled={disabled}
            onSelect={() => onJointSelected?.(limit.name)}
            onChange={(next) =>
              publishEdit(
                setCalibrationJointValue(limits, value, limit.name, next),
              )
            }
          />
        ))}
        {visibleLimits.length === 0 && (
          <p className="py-2 text-center text-[11px] text-muted-foreground">
            No matching joints
          </p>
        )}
      </div>

      <div className="grid grid-cols-4 gap-1.5 border-t border-border-subtle pt-2.5">
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => showComparison("zero")}
        >
          Zero
        </Button>
        <Button
          size="sm"
          disabled={disabled || !hasSavedBaseline}
          title={hasSavedBaseline ? "Restore the saved calibration" : "No saved calibration"}
          onClick={() => showComparison("saved")}
        >
          Reset
        </Button>
        <Button size="sm" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={disabled} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
