/**
 * Browser-independent identities owned by the Workbench shell. Runtime
 * adapters may depend on this contract without reaching into React or a
 * browser-only service.
 */
export const WORKSPACE_PANEL_IDS = [
  "motion",
  "robot-assets",
  "video-to-motion",
  "h2r",
  "batch",
  "r2r",
  "dataset-viz",
] as const;

export type WorkspacePanelId = (typeof WORKSPACE_PANEL_IDS)[number];

export const WORKSPACE_LOCALES = ["en", "zh-CN"] as const;

export type WorkspaceLocale = (typeof WORKSPACE_LOCALES)[number];

export const WORKSPACE_THEMES = ["light", "dark"] as const;

export type WorkspaceTheme = (typeof WORKSPACE_THEMES)[number];
