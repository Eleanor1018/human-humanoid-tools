import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  applyStageMenuValue,
  projectStageMenuValue,
  type StandardStageLayerAvailability,
  type StandardStageLayerId,
} from "./presentation";
import type {
  R2rLayerAvailability,
  R2rStageLayerId,
  StageLayerId,
} from "./types";

interface StageLayer {
  readonly id: StageLayerId;
  readonly legacyId: string;
  readonly label: string;
  readonly accessibleLabel?: string;
  readonly title: string;
  readonly family: "source" | "scaled" | "robot";
}

interface StageLayerRow {
  readonly id: string;
  readonly label?: string;
  readonly layers: readonly StageLayer[];
}

const layerRows: readonly StageLayerRow[] = [
  {
    id: "motion",
    layers: [
      {
        id: "skeleton",
        legacyId: "tg-skeleton",
        label: "Skeleton",
        title: "Skeleton",
        family: "source",
      },
      {
        id: "body",
        legacyId: "tg-mesh",
        label: "Body",
        title: "Body",
        family: "source",
      },
      {
        id: "objects",
        legacyId: "tg-env",
        label: "Objects/Terrain",
        title: "Objects/Terrain",
        family: "source",
      },
    ],
  },
  {
    id: "robot",
    layers: [
      {
        id: "scaled-skeleton",
        legacyId: "tg-scaled",
        label: "Scaled",
        accessibleLabel: "Scaled Skeleton",
        title: "Scaled Skeleton",
        family: "scaled",
      },
      {
        id: "scaled-scene",
        legacyId: "tg-scaled-env",
        label: "Scaled",
        accessibleLabel: "Scaled Scene",
        title: "Scaled Scene",
        family: "scaled",
      },
      {
        id: "robot",
        legacyId: "tg-robot",
        label: "Robot",
        title: "Robot",
        family: "robot",
      },
    ],
  },
];

const r2rLayerRows: readonly StageLayerRow[] = [
  {
    id: "r2r-src",
    label: "Source",
    layers: [
      {
        id: "r2r-source-robot",
        legacyId: "r2r-tg-src-robot",
        label: "Robot",
        accessibleLabel: "Source Robot",
        title: "Robot",
        family: "robot",
      },
      {
        id: "r2r-source-skeleton",
        legacyId: "r2r-tg-src-skel",
        label: "Skeleton",
        accessibleLabel: "Source Skeleton",
        title: "Skeleton",
        family: "source",
      },
      {
        id: "r2r-source-scene",
        legacyId: "r2r-tg-src-env",
        label: "Objects/Terrain",
        accessibleLabel: "Source Objects/Terrain",
        title: "Objects/Terrain",
        family: "source",
      },
    ],
  },
  {
    id: "r2r-tgt",
    label: "Target",
    layers: [
      {
        id: "r2r-target-robot",
        legacyId: "r2r-tg-tgt-robot",
        label: "Robot",
        accessibleLabel: "Target Robot",
        title: "Robot",
        family: "robot",
      },
      {
        id: "r2r-target-skeleton",
        legacyId: "r2r-tg-tgt-skel",
        label: "Skeleton",
        accessibleLabel: "Target Skeleton",
        title: "Skeleton",
        family: "scaled",
      },
      {
        id: "r2r-target-scene",
        legacyId: "r2r-tg-tgt-env",
        label: "Objects/Terrain",
        accessibleLabel: "Target Objects/Terrain",
        title: "Objects/Terrain",
        family: "scaled",
      },
    ],
  },
];

const activeFamilyClass: Record<StageLayer["family"], string> = {
  source: "data-[state=on]:bg-[#0071e3] data-[state=on]:hover:bg-[#0071e3]",
  scaled: "data-[state=on]:bg-[#007c83] data-[state=on]:hover:bg-[#007c83]",
  robot: "data-[state=on]:bg-[#8e44ad] data-[state=on]:hover:bg-[#8e44ad]",
};

interface StageViewMenuProps {
  value: StageLayerId[];
  onValueChange(value: StageLayerId[]): void;
  availability: StandardStageLayerAvailability;
  calibration?: boolean;
  r2rAvailability?: R2rLayerAvailability;
}

export function StageViewMenu({
  value,
  onValueChange,
  availability,
  calibration = false,
  r2rAvailability,
}: StageViewMenuProps) {
  const r2r = r2rAvailability !== undefined;
  const rows = r2r ? r2rLayerRows : layerRows;
  const menuValue = projectStageMenuValue(value, calibration, r2r);
  const available = (layer: StageLayer): boolean =>
    layer.id.startsWith("r2r-")
      ? Boolean(r2rAvailability?.[layer.id as R2rStageLayerId])
      : availability[layer.id as StandardStageLayerId];
  const locked = (layer: StageLayer): boolean =>
    calibration && (r2r || layer.id !== "robot");

  return (
    <ToggleGroup
      type="multiple"
      value={menuValue}
      onValueChange={(next) =>
        onValueChange(
          applyStageMenuValue(value, next as StageLayerId[], calibration, r2r),
        )
      }
      size="sm"
      aria-label="Stage visibility"
      className="stage-view-menu absolute top-3 left-3 z-[25] flex w-fit max-w-[calc(100%_-_36px)] flex-col items-stretch gap-1 rounded-lg border border-black/10 bg-white/[.85] px-2 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,0.08)] backdrop-blur-[20px] @max-[440px]:top-2 @max-[440px]:left-2 @max-[440px]:max-w-[calc(100%_-_16px)]"
    >
      {rows.map((row) => (
        <div
          key={row.id}
          data-row={row.id}
          className="flex flex-nowrap items-center gap-[3px]"
        >
          {row.label && (
            <span className="min-w-[2.2em] shrink-0 text-center text-[11px] font-bold text-[#a1a1a6]">
              {row.label}
            </span>
          )}
          {row.layers.map((layer) => (
            <ToggleGroupItem
              key={layer.id}
              id={layer.legacyId}
              value={layer.id}
              disabled={!available(layer) || locked(layer)}
              title={layer.title}
              aria-label={layer.accessibleLabel ?? layer.label}
              data-family={layer.family}
              className={cn(
                "group h-auto w-auto cursor-pointer gap-[5px] rounded-sm border-0 bg-transparent px-3 py-1.5 text-xs leading-[normal] font-semibold text-[#6e6e73] transition-[background-color,color,opacity] duration-150 hover:bg-[rgba(0,113,227,0.12)] hover:text-[#1d1d1f] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-35 disabled:grayscale-[.35] data-[state=on]:text-white",
                activeFamilyClass[layer.family],
              )}
            >
              <span
                className="stage-layer-eye size-[13px] shrink-0 bg-current opacity-45 grayscale-[.6] [mask:url(/icons/stage/eye.svg)_center/contain_no-repeat] [-webkit-mask:url(/icons/stage/eye.svg)_center/contain_no-repeat] group-hover:opacity-75 group-data-[state=on]:opacity-100 group-data-[state=on]:grayscale-0"
                aria-hidden="true"
              />
              <span>{layer.label}</span>
            </ToggleGroupItem>
          ))}
        </div>
      ))}
    </ToggleGroup>
  );
}
