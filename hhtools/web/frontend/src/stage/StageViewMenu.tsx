import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";

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
      disabled: true,
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
      disabled: true,
    },
  ],
];

interface StageViewMenuProps {
  value: StageLayerId[];
  onValueChange(value: StageLayerId[]): void;
}

export function StageViewMenu({ value, onValueChange }: StageViewMenuProps) {
  return (
    <ToggleGroup
      type="multiple"
      value={value}
      onValueChange={(next) => onValueChange(next as StageLayerId[])}
      size="sm"
      aria-label="Stage visibility"
      className="stage-view-menu"
    >
      {layerRows.map((row, index) => (
        <div
          key={index}
          className="stage-view-menu-row"
        >
          {row.map((layer) => (
            <ToggleGroupItem
              key={layer.id}
              value={layer.id}
              disabled={layer.disabled}
              title={layer.title}
              aria-label={layer.accessibleLabel ?? layer.label}
              data-family={layer.family}
              className="stage-layer-toggle"
            >
              <span className="stage-layer-eye" aria-hidden="true" />
              <span>{layer.label}</span>
            </ToggleGroupItem>
          ))}
        </div>
      ))}
    </ToggleGroup>
  );
}
