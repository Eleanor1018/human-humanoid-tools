import type { ViewId } from "@/navigation";

export const TUTORIAL_STORAGE_KEY = "hhtools.web.tutorial.v2.seen";
export const LEGACY_TUTORIAL_STORAGE_KEY = "hhtools.web.tutorial.v1.done";

export type TutorialPlacement = "top" | "right" | "bottom" | "left";

export interface TutorialStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TutorialPersistenceBridge {
  hasSeenTutorial(): Promise<boolean>;
  markTutorialSeen(): Promise<void>;
}

export interface TutorialCopy {
  readonly en: string;
  readonly zh: string;
}

export interface TutorialStep {
  readonly id:
    | "welcome"
    | "motion-import"
    | "motion-library"
    | "robot-import"
    | "calibration"
    | "retarget"
    | "stage-layers"
    | "export"
    | "done";
  readonly view: ViewId;
  readonly anchor: string;
  readonly placement: TutorialPlacement;
  readonly title: TutorialCopy;
  readonly body: TutorialCopy;
}

function copy(en: string, zh: string): TutorialCopy {
  return { en, zh };
}

function browserStorage(): TutorialStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function hasSeenFirstRunTutorial(
  storage: Pick<TutorialStorage, "getItem"> | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return (
      storage.getItem(TUTORIAL_STORAGE_KEY) === "1" ||
      storage.getItem(LEGACY_TUTORIAL_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function markFirstRunTutorialSeen(
  storage: Pick<TutorialStorage, "setItem"> | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(TUTORIAL_STORAGE_KEY, "1");
  } catch {
    // Restricted browser contexts can reject persistence; the live tour still works.
  }
}

export async function shouldAutoOpenTutorial(
  storage: Pick<TutorialStorage, "getItem"> | undefined,
  bridge?: Partial<TutorialPersistenceBridge>,
): Promise<boolean> {
  if (hasSeenFirstRunTutorial(storage)) return false;
  if (!bridge?.hasSeenTutorial) return true;
  try {
    return !(await bridge.hasSeenTutorial());
  } catch {
    return true;
  }
}

export async function rememberTutorialSeen(
  storage: Pick<TutorialStorage, "setItem"> | undefined,
  bridge?: Partial<TutorialPersistenceBridge>,
): Promise<void> {
  markFirstRunTutorialSeen(storage);
  try {
    await bridge?.markTutorialSeen?.();
  } catch {
    // The browser marker still prevents repeated tours on this origin.
  }
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: "welcome",
    view: "motion",
    anchor: "#topbar",
    placement: "bottom",
    title: copy("1. Welcome to hhtools", "1. 欢迎使用 hhtools"),
    body: copy(
      "This guide follows the recommended workspace order: Motion, Robot, Calibration, Retarget, Preview, and Export. Use the top menu for application commands and the left navigation to switch assets, workflows, and analysis tools.",
      "本教程会按推荐顺序介绍工作区：动作、机器人、标定、重定向、预览和导出。顶部菜单用于应用命令，左侧导航用于切换资源、工作流与分析工具。",
    ),
  },
  {
    id: "motion-import",
    view: "motion",
    anchor: '[data-tutorial="motion-import"]',
    placement: "left",
    title: copy("2. Import motion", "2. 导入动作"),
    body: copy(
      "Choose the matching motion profile, then import a file or folder. mimic accepts common motion data, intermimic handles human-object interaction, and meshmimic handles terrain-aware motion. Compatible data can also be dropped onto the workspace.",
      "先选择对应的动作类型，再导入文件或文件夹。mimic 用于常见动作数据，intermimic 用于人体与物体交互动作，meshmimic 用于包含地形的动作。也可以把兼容数据直接拖入工作区。",
    ),
  },
  {
    id: "motion-library",
    view: "motion",
    anchor: '[data-tutorial="motion-library"]',
    placement: "left",
    title: copy("3. Reuse the Motion Library", "3. 复用动作资源库"),
    body: copy(
      "The Motion Library lists reusable clips without another upload. Filter by motion type, search by name, or choose a different local library directory. Select a row to load it into the stage.",
      "动作资源库会列出可直接复用的片段，无需重复上传。你可以按动作类型筛选、按名称搜索，或切换本地资源库目录；选择一行即可加载到舞台。",
    ),
  },
  {
    id: "robot-import",
    view: "robot-assets",
    anchor: '[data-tutorial="robot-import"]',
    placement: "left",
    title: copy("4. Import or load a robot", "4. 导入或加载机器人"),
    body: copy(
      "Import the robot .urdf first, then its meshes folder. Built-in and previously registered robots can be loaded directly from the Robot Library.",
      "先导入机器人的 .urdf 文件，再导入对应的 meshes 文件夹。内置或已经注册的机器人可以直接从机器人资源库加载。",
    ),
  },
  {
    id: "calibration",
    view: "h2r",
    anchor: '[data-tutorial="h2r-calibration"]',
    placement: "left",
    title: copy("5. Calibrate the target robot", "5. 标定目标机器人"),
    body: copy(
      "Before the first retarget, align the robot with the reference skeleton. Select a joint in the 3D stage or use the calibration controls, then save the calibration for this robot and reference.",
      "首次重定向前，需要把机器人与参考骨架对齐。可以在 3D 舞台选择关节，或使用标定控制项进行调整，最后保存当前机器人与参考骨架的标定。",
    ),
  },
  {
    id: "retarget",
    view: "h2r",
    anchor: '[data-tutorial="h2r-result"]',
    placement: "left",
    title: copy("6. Run Human to Robot", "6. 执行人体到机器人"),
    body: copy(
      "With a motion, robot, and calibration ready, choose the solver and optional Retarget FPS, then start Retarget. Newton IK handles regular motion; Interaction-Mesh handles clips with interaction objects or terrain.",
      "动作、机器人和标定就绪后，选择求解器与可选的重定向 FPS，再开始重定向。Newton IK 适合常规动作；Interaction-Mesh 适合带交互物体或地形的动作。",
    ),
  },
  {
    id: "stage-layers",
    view: "motion",
    anchor: ".stage-view-menu",
    placement: "bottom",
    title: copy("7. Inspect the 3D layers", "7. 检查 3D 显示层"),
    body: copy(
      "Use the stage controls to compare the source skeleton or body, objects and terrain, the calibrated reference, and the retargeted robot. Multiple layers can remain visible for alignment checks.",
      "使用舞台控制项对比源骨架或人体、物体与地形、标定后的参考层以及重定向机器人。多个显示层可以同时打开，便于检查对齐效果。",
    ),
  },
  {
    id: "export",
    view: "h2r",
    anchor: '[data-tutorial="h2r-result"]',
    placement: "left",
    title: copy("8. Export the result", "8. 导出结果"),
    body: copy(
      "After Retarget finishes, the Result step shows export controls. Choose CSV or PKL, adjust the output range or FPS when needed, and download the generated trajectory.",
      "重定向完成后，结果步骤会显示导出控制项。可以选择 CSV 或 PKL，并按需调整导出区间或 FPS，然后下载生成的轨迹。",
    ),
  },
  {
    id: "done",
    view: "motion",
    anchor: '[data-menu-trigger="help"]',
    placement: "bottom",
    title: copy("9. Tutorial complete", "9. 教程完成"),
    body: copy(
      "The guide opens automatically only on your first visit. To review it later, open Help, then Tutorial. Video to Motion, Robot to Robot, Batch, and Data Analysis remain available from the left navigation.",
      "教程只会在首次进入时自动显示。以后需要复习时，请打开顶部的帮助菜单，再选择教程。视频到动作、机器人到机器人、批处理和数据分析仍可从左侧导航进入。",
    ),
  },
];
