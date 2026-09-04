import type { ComponentType } from "react";

import type { WorkspaceLocale, WorkspacePanelId } from "./workspace";

/** Values supplied by the shell whenever it renders a contributed panel. */
export interface WorkbenchPanelProps {
  locale: WorkspaceLocale;
  requestPanel(panel: WorkspacePanelId): void;
}

/**
 * Declarative view extension consumed by the generic Workbench shell.
 *
 * Concrete features create these descriptors, while only the composition root
 * imports those features. This keeps the shell closed to feature additions.
 */
export interface WorkbenchPanelContribution {
  readonly id: WorkspacePanelId;
  readonly component: ComponentType<WorkbenchPanelProps>;
}
