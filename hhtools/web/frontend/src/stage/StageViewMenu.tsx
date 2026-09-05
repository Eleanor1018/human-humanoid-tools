import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type StageLayerId =
  | "skeleton"
  | "body"
  | "objects"
  | "scaled-skeleton"
  | "scaled-scene"
  | "robot";

interface StageLayer {
  id: StageLayerId;
  label: string;
  accessibleLabel?: string;
  title: string;
  family: "source" | "scaled" | "robot";
  disabled?: boolean;
}

const layerRows: readonly (readonly StageLayer[])[] = [
  [
    {
      id: "skeleton",
      label: "Skeleton",
      title: "Show or hide the source motion skeleton",
      family: "source",
    },
    {
      id: "body",
      label: "Body",
      title: "Show or hide the body mesh",
      family: "source",
    },
    {
      id: "objects",
      label: "Objects/Terrain",
      title: "Show or hide source terrain and interaction objects",
      family: "source",
    },
  ],
  [
    {
      id: "scaled-skeleton",
      label: "Scaled",
      accessibleLabel: "Scaled Skeleton",
      title: "Effector skeleton after robot scaling and before IK",
      family: "scaled",
      disabled: true,
    },
    {
      id: "scaled-scene",
      label: "Scaled",
      accessibleLabel: "Scaled Scene",
      title: "Scaled terrain and interaction objects in robot coordinates",
      family: "scaled",
      disabled: true,
    },
    {
      id: "robot",
      label: "Robot",
      title: "Show or hide the retargeted robot",
      family: "robot",
    },
  ],
];

const activeFamilyClass: Record<StageLayer["family"], string> = {
  source: "data-[state=on]:bg-[#0071e3] data-[state=on]:hover:bg-[#0071e3]",
  scaled: "data-[state=on]:bg-[#007c83] data-[state=on]:hover:bg-[#007c83]",
  robot: "data-[state=on]:bg-[#8e44ad] data-[state=on]:hover:bg-[#8e44ad]",
};

interface StageViewMenuProps {
  value: StageLayerId[];
  onValueChange(value: StageLayerId[]): void;
  robotAvailable?: boolean;
  environmentAvailable?: boolean;
}

export function StageViewMenu({
  value,
  onValueChange,
  robotAvailable = false,
  environmentAvailable = false,
}: StageViewMenuProps) {
  return (
    <ToggleGroup
      type="multiple"
      value={value}
      onValueChange={(next) => onValueChange(next as StageLayerId[])}
      size="sm"
      aria-label="Stage visibility"
      className="stage-view-menu absolute top-3 left-3 z-[25] flex w-fit max-w-[calc(100%_-_24px)] flex-col items-stretch gap-1 rounded-lg border border-black/10 bg-white/[.85] px-2 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,0.08)] backdrop-blur-[20px] @max-[440px]:top-2 @max-[440px]:left-2 @max-[440px]:max-w-[calc(100%_-_16px)]"
    >
      {layerRows.map((row, index) => (
        <div
          key={index}
          className="flex flex-nowrap items-center gap-[3px]"
        >
          {row.map((layer) => (
            <ToggleGroupItem
              key={layer.id}
              value={layer.id}
              disabled={
                layer.disabled ||
                (layer.id === "robot" && !robotAvailable) ||
                (layer.id === "objects" && !environmentAvailable)
              }
              title={layer.title}
              aria-label={layer.accessibleLabel ?? layer.label}
              data-family={layer.family}
              className={cn(
                "group h-auto w-auto cursor-pointer gap-[5px] rounded-sm border-0 bg-transparent px-3 py-1.5 text-xs font-semibold leading-normal text-[#6e6e73] hover:bg-[#0071e3]/10 hover:text-[#1d1d1f] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-35 disabled:grayscale-[.35] data-[state=on]:text-white",
                activeFamilyClass[layer.family],
              )}
            >
              <span
                className="stage-layer-eye size-[13px] shrink-0 bg-current opacity-45 [mask:url(/icons/stage/eye.svg)_center/contain_no-repeat] [-webkit-mask:url(/icons/stage/eye.svg)_center/contain_no-repeat] group-data-[state=on]:opacity-100"
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
