import type { ViewId } from "./navigation";
import type { ApplicationImportTarget } from "./importIntent";

export type {
  ApplicationImportRequest,
  ApplicationImportTarget,
} from "./importIntent";

export type ApplicationTheme = "light" | "dark";
export type ApplicationMenuId =
  | "file"
  | "workflows"
  | "analysis"
  | "settings"
  | "help";
export type ApplicationCommandId =
  | "import-motion-file"
  | "import-motion-folder"
  | "import-video"
  | "import-robot-urdf"
  | "import-robot-mesh-folder"
  | "export-current-result"
  | "exit-application"
  | "navigate-video-to-motion"
  | "navigate-h2r"
  | "navigate-r2r"
  | "navigate-batch"
  | "navigate-analysis"
  | "open-settings"
  | "toggle-theme"
  | "open-tutorial"
  | "open-about";

export interface ApplicationCommand {
  readonly id: ApplicationCommandId;
  readonly label: string;
  readonly detail: string;
  readonly shortcut?: string;
  readonly dividerBefore?: boolean;
  readonly enabled?: boolean;
  readonly disabledReason?: string;
  readonly run: () => void;
}

export interface ApplicationMenu {
  readonly id: ApplicationMenuId;
  readonly label: string;
  readonly commands: readonly ApplicationCommand[];
}

export interface ApplicationCommandContext {
  readonly theme: ApplicationTheme;
  readonly canExportResult: boolean;
  readonly canExitApplication: boolean;
  readonly onNavigate: (view: ViewId) => void;
  readonly onImport: (target: ApplicationImportTarget) => void;
  readonly onExportResult: () => void;
  readonly onOpenSettings: () => void;
  readonly onToggleTheme: () => void;
  readonly onOpenTutorial: () => void;
  readonly onOpenAbout: () => void;
  readonly onExitApplication: () => void;
}

const SHORTCUT_VIEWS: Readonly<Record<string, ViewId>> = {
  "1": "motion",
  "2": "robot-assets",
  "3": "h2r",
  "4": "r2r",
  "5": "batch",
  "6": "dataset-viz",
  "7": "video-to-motion",
};

const IMPORT_VIEWS: Readonly<Record<ApplicationImportTarget, ViewId>> = {
  "motion-file": "motion",
  "motion-folder": "motion",
  "video-file": "video-to-motion",
  "robot-urdf": "robot-assets",
  "robot-mesh-folder": "robot-assets",
};

export const THEME_STORAGE_KEY = "hhtools.theme";
export const PROJECT_README_URL =
  "https://github.com/Eleanor1018/human-humanoid-tools#readme";

export function viewForImport(target: ApplicationImportTarget): ViewId {
  return IMPORT_VIEWS[target];
}

export function storedTheme(
  storage: Pick<Storage, "getItem"> | undefined,
): ApplicationTheme {
  try {
    return storage?.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function isEditingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const candidate = target as {
    readonly tagName?: unknown;
    readonly isContentEditable?: unknown;
  };
  const tagName =
    typeof candidate.tagName === "string"
      ? candidate.tagName.toLowerCase()
      : "";
  return (
    candidate.isContentEditable === true ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

export function viewForNavigationShortcut(
  event: Pick<
    KeyboardEvent,
    "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "key" | "target"
  >,
): ViewId | null {
  if (
    !event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditingTarget(event.target)
  ) {
    return null;
  }
  return SHORTCUT_VIEWS[event.key] ?? null;
}

function navigationCommand(
  id: ApplicationCommandId,
  label: string,
  detail: string,
  shortcut: string,
  view: ViewId,
  onNavigate: (view: ViewId) => void,
): ApplicationCommand {
  return {
    id,
    label,
    detail,
    shortcut,
    run: () => onNavigate(view),
  };
}

function importCommand(
  id: ApplicationCommandId,
  label: string,
  detail: string,
  target: ApplicationImportTarget,
  onImport: (target: ApplicationImportTarget) => void,
  dividerBefore = false,
): ApplicationCommand {
  return {
    id,
    label,
    detail,
    dividerBefore,
    run: () => onImport(target),
  };
}

/** Build one typed command snapshot for the current App capabilities. */
export function createApplicationMenus(
  context: ApplicationCommandContext,
): readonly ApplicationMenu[] {
  return [
    {
      id: "file",
      label: "File",
      commands: [
        importCommand(
          "import-motion-file",
          "Import Motion File",
          "Import a motion asset",
          "motion-file",
          context.onImport,
        ),
        importCommand(
          "import-motion-folder",
          "Import Motion Folder",
          "Import a motion dataset folder",
          "motion-folder",
          context.onImport,
        ),
        importCommand(
          "import-video",
          "Import Video",
          "Select a Video to Motion source",
          "video-file",
          context.onImport,
          true,
        ),
        importCommand(
          "import-robot-urdf",
          "Import Robot URDF",
          "Import a robot description",
          "robot-urdf",
          context.onImport,
          true,
        ),
        importCommand(
          "import-robot-mesh-folder",
          "Import Robot Mesh Folder",
          "Select the meshes referenced by the robot URDF",
          "robot-mesh-folder",
          context.onImport,
        ),
        {
          id: "export-current-result",
          label: "Current Result…",
          detail: "Download the active retarget result as CSV",
          enabled: context.canExportResult,
          disabledReason: context.canExportResult
            ? undefined
            : "No exportable result",
          run: context.onExportResult,
        },
        {
          id: "exit-application",
          label: "Exit",
          detail: "Close HHTOOLS",
          dividerBefore: true,
          enabled: context.canExitApplication,
          disabledReason: context.canExitApplication
            ? undefined
            : "Desktop app only",
          run: context.onExitApplication,
        },
      ],
    },
    {
      id: "workflows",
      label: "Workflows",
      commands: [
        navigationCommand(
          "navigate-video-to-motion",
          "Video to Motion",
          "Generate motion from video with GVHMR",
          "Alt+7",
          "video-to-motion",
          context.onNavigate,
        ),
        navigationCommand(
          "navigate-h2r",
          "Human to Robot",
          "Retarget human motion to a robot",
          "Alt+3",
          "h2r",
          context.onNavigate,
        ),
        navigationCommand(
          "navigate-r2r",
          "Robot to Robot",
          "Retarget a trajectory across robot embodiments",
          "Alt+4",
          "r2r",
          context.onNavigate,
        ),
        navigationCommand(
          "navigate-batch",
          "Batch",
          "Run batch workflows",
          "Alt+5",
          "batch",
          context.onNavigate,
        ),
      ],
    },
    {
      id: "analysis",
      label: "Analysis",
      commands: [
        navigationCommand(
          "navigate-analysis",
          "Data Analysis",
          "Inspect motion and trajectory datasets",
          "Alt+6",
          "dataset-viz",
          context.onNavigate,
        ),
      ],
    },
    {
      id: "settings",
      label: "Settings",
      commands: [
        {
          id: "open-settings",
          label: "Settings",
          detail: "Configure background-job admission",
          run: context.onOpenSettings,
        },
        {
          id: "toggle-theme",
          label: context.theme === "dark" ? "Light Mode" : "Dark Mode",
          detail: `Switch to ${context.theme === "dark" ? "light" : "dark"} appearance`,
          run: context.onToggleTheme,
        },
      ],
    },
    {
      id: "help",
      label: "Help",
      commands: [
        {
          id: "open-tutorial",
          label: "Tutorial",
          detail: "Open the project README",
          run: context.onOpenTutorial,
        },
        {
          id: "open-about",
          label: "About hhtools",
          detail: "Project and source information",
          dividerBefore: true,
          run: context.onOpenAbout,
        },
      ],
    },
  ];
}
