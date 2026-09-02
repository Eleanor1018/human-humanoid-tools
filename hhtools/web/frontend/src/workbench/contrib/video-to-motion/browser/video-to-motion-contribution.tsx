import type { ICommandService } from "@/platform/commands/common/command-service";
import type {
  WorkbenchPanelContribution,
  WorkbenchPanelProps,
} from "@/workbench/common/panel-contribution";
import type { VideoToMotionControllerDependencies } from "./video-to-motion-controller";
import { VideoToMotionView } from "./video-to-motion-view";
import { useVideoToMotionController } from "./use-video-to-motion-controller";

export interface VideoToMotionContributionDependencies
  extends VideoToMotionControllerDependencies {
  readonly commandService: Pick<ICommandService, "registerCommand">;
}

/**
 * Build the V2M panel at the application composition boundary.
 *
 * The returned React component owns its controller through a hook, while the
 * generic Workbench sees only a panel descriptor. Concrete transport, jobs,
 * presentation, and commands therefore flow inward as explicit ports instead
 * of being discovered from a service context inside the feature.
 */
export function createVideoToMotionPanelContribution(
  dependencies: VideoToMotionContributionDependencies,
): WorkbenchPanelContribution {
  const { commandService, ...controllerDependencies } = dependencies;

  function VideoToMotionContributionView(
    props: WorkbenchPanelProps,
  ) {
    const model = useVideoToMotionController(controllerDependencies);
    return (
      <VideoToMotionView
        {...props}
        model={model}
        commandService={commandService}
      />
    );
  }

  return {
    id: "video-to-motion",
    component: VideoToMotionContributionView,
  };
}
