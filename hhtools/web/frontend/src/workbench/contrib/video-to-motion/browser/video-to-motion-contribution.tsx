import type { WorkbenchPanelContribution } from "@/workbench/common/panel-contribution";
import { VideoToMotionPanel } from "./video-to-motion-panel";

/** Panel descriptor registered by main.tsx at the application boundary. */
export const videoToMotionPanelContribution = {
  id: "video-to-motion",
  component: VideoToMotionPanel,
} satisfies WorkbenchPanelContribution;
