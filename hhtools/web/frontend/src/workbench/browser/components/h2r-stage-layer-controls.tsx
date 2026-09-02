import type { WorkspaceLocale } from "@/workbench/common/workspace";
import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import { useStageDisplayState } from "@/workbench/services/stage/browser/use-stage-model-state";
import type {
  IStageLayerCommands,
  IStageModelService,
  StageLayerId,
} from "@/workbench/services/stage/common/stage-service";

import { StageLayerToggle } from "./stage-layer-toggle";

interface H2rLayerToggleDescriptor {
  readonly id: string;
  readonly layerId: StageLayerId;
  readonly en: string;
  readonly zh: string;
}

const MOTION_LAYER_TOGGLES = [
  {
    id: "tg-skeleton",
    layerId: "sourceSkeleton",
    en: "Skeleton",
    zh: "骨架",
  },
  { id: "tg-mesh", layerId: "sourceBody", en: "Body", zh: "身体" },
  {
    id: "tg-env",
    layerId: "sourceEnvironment",
    en: "Objects/Terrain",
    zh: "物体/地形",
  },
] as const satisfies readonly H2rLayerToggleDescriptor[];

const ROBOT_LAYER_TOGGLES = [
  {
    id: "tg-scaled",
    layerId: "scaledSkeleton",
    en: "Scaled Skeleton",
    zh: "缩放骨架",
  },
  {
    id: "tg-scaled-env",
    layerId: "scaledEnvironment",
    en: "Scaled Scene",
    zh: "缩放场景",
  },
  {
    id: "tg-robot",
    layerId: "targetRobot",
    en: "Robot",
    zh: "机器人",
  },
] as const satisfies readonly H2rLayerToggleDescriptor[];

/**
 * React-owned read and intent sides for the six H2R layer controls.
 *
 * A click emits only a semantic command. Presentation changes after the
 * renderer publishes its next confirmed snapshot, so there is no optimistic
 * second source of truth in this component.
 */
export function H2rStageLayerControls({
  locale,
  stageLayerCommands,
  stageModelService,
}: {
  readonly locale: WorkspaceLocale;
  readonly stageLayerCommands: IStageLayerCommands;
  readonly stageModelService: IStageModelService;
}) {
  const text = useLocaleText(locale);
  const { layers } = useStageDisplayState(stageModelService);
  const renderToggle = (descriptor: H2rLayerToggleDescriptor) => {
    const layer = layers[descriptor.layerId];
    return (
      <StageLayerToggle
        key={descriptor.id}
        id={descriptor.id}
        active={layer.visible}
        disabled={!layer.canToggle}
        onClick={() => stageLayerCommands.toggleLayer(descriptor.layerId)}
        title={text(descriptor.en, descriptor.zh)}
        label={text(
          descriptor.en.split(" ")[0] || descriptor.en,
          descriptor.zh.split(" ")[0] || descriptor.zh,
        )}
      />
    );
  };

  return (
    <div className="view-hud" id="view-hud">
      <div className="view-hud-row" data-row="motion">
        {MOTION_LAYER_TOGGLES.map(renderToggle)}
      </div>
      <div className="view-hud-row" data-row="robot">
        {ROBOT_LAYER_TOGGLES.map(renderToggle)}
      </div>
    </div>
  );
}
