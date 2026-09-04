/**
 * Imperative overlay adapter for the first-run guide. The step definitions are
 * declarative, but highlighting and positioning remain here because they must
 * measure DOM nodes after React has laid out the requested workspace panel.
 * React owns the anchors; this module temporarily reveals them and restores
 * their previous state when a step is left.
 */

const STORAGE_KEY = "hhtools.web.tutorial.v2.seen";
const LEGACY_DONE_STORAGE_KEY = "hhtools.web.tutorial.v1.done";

type ToastFunction = (message: string, isError?: boolean) => void;
type TourPlacement = "top" | "right" | "bottom" | "left";
type TutorialStorage = Pick<Storage, "getItem" | "setItem">;

interface LocalizedCopy {
  en: string;
  zh: string;
}

interface TourStepContext {
  revealExportCard: (visible: boolean) => void;
  revealDetails: (detailsId: string, visible: boolean) => void;
}

interface TourStep {
  id: string;
  panel: string;
  anchor: string;
  title: LocalizedCopy;
  body: LocalizedCopy;
  placement: TourPlacement;
  last?: boolean;
  beforeShow?: (context: TourStepContext) => void;
  afterLeave?: (context: TourStepContext) => void;
}

function copy(en: string, zh: string): LocalizedCopy {
  return { en, zh };
}

function localized(value: LocalizedCopy): string {
  return document.documentElement.lang.toLowerCase().startsWith("zh") ? value.zh : value.en;
}

function browserStorage(): TutorialStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Treat the legacy completion flag as seen so existing users do not receive
 * the revised first-run guide again after upgrading.
 */
export function hasSeenFirstRunTutorial(storage: TutorialStorage | undefined = browserStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(STORAGE_KEY) === "1" || storage.getItem(LEGACY_DONE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Record the automatic guide as soon as it is scheduled, not only when it finishes. */
export function markFirstRunTutorialSeen(storage: TutorialStorage | undefined = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage can be unavailable in a private or restricted renderer.
  }
}

/**
 * Ordered product journey; selectors are part of the React/runtime DOM contract.
 * Hooks that reveal an element must restore it with the matching leave hook.
 */
const STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    panel: "motion",
    anchor: "#topbar",
    title: copy("1. Welcome to hhtools", "1. 欢迎使用 hhtools"),
    body: copy(
      "This guide introduces the workspace in its recommended order: <b>Motion → Robot → Calibration → Retarget → Preview → Export</b>. Use the top menu for application commands and the left navigation to switch assets, workflows, and analysis tools.",
      "本教程按推荐顺序介绍工作区：<b>动作 → 机器人 → 标定 → Retarget → 预览 → 导出</b>。顶部菜单用于应用命令，左侧导航用于切换资产、工作流与分析工具。",
    ),
    placement: "bottom",
  },
  {
    id: "motion",
    panel: "motion",
    anchor: "#tour-motion-import",
    title: copy("2. Import motion", "2. 导入动作"),
    body: copy(
      "Choose the matching motion profile, then import a file or folder:<br>• <b>mimic</b>: BVH / GLB / NPZ and common motion datasets<br>• <b>intermimic</b>: human-object interaction clips<br>• <b>meshmimic</b>: terrain-aware motion clips<br>You can also drop compatible data directly onto the 3D stage.",
      "先选择对应的动作类型，再导入文件或文件夹：<br>• <b>mimic</b>：BVH / GLB / NPZ 与常见动作数据集<br>• <b>intermimic</b>：人体与物体交互动作<br>• <b>meshmimic</b>：包含地形的动作<br>也可以把兼容数据直接拖到中间 3D 舞台。",
    ),
    placement: "left",
  },
  {
    id: "motion-library",
    panel: "motion",
    anchor: "#tour-motion-library",
    title: copy("3. Reuse the Motion Library", "3. 复用动作资源库"),
    body: copy(
      "The Motion Library lists reusable clips without requiring another upload. Filter by motion type, search by name, or choose a different local library directory. Select a row to load it into the stage.",
      "动作资源库会列出可直接复用的 clip，无需重复上传。你可以按类型筛选、按名称搜索，或切换本地资源库目录；选择一行即可加载到舞台。",
    ),
    placement: "left",
  },
  {
    id: "robot",
    panel: "robot-assets",
    anchor: "#tour-robot-import",
    title: copy("4. Import or load a robot", "4. 导入或加载机器人"),
    body: copy(
      "Import the robot <code>.urdf</code> first, then its <code>meshes/</code> directory. Built-in and previously registered robots can be loaded directly from the robot library, keeping reusable robot assets separate from a workflow run.",
      "先导入机器人的 <code>.urdf</code>，再导入对应的 <code>meshes/</code> 目录。内置或已经注册的机器人可直接从机器人资源库加载，让可复用资产与具体工作流分开管理。",
    ),
    placement: "left",
  },
  {
    id: "calibration",
    panel: "h2r",
    anchor: "#tour-calibration",
    title: copy("5. Calibrate the target robot", "5. 标定目标机器人"),
    body: copy(
      "Before the first retarget, align the gray robot with the blue reference skeleton. Select a joint in the 3D stage or use the controls in this step, then save the calibration for this robot and source reference.",
      "首次 Retarget 前，需要把灰色机器人对齐到蓝色参考骨架。可以在 3D 舞台选择关节，或使用本步骤中的控制项进行调整，最后保存当前机器人与源参考骨架的标定。",
    ),
    placement: "left",
    beforeShow: ({ revealDetails }) => revealDetails("h2r-step-calibration", true),
    afterLeave: ({ revealDetails }) => revealDetails("h2r-step-calibration", false),
  },
  {
    id: "retarget",
    panel: "h2r",
    anchor: "#h2r-step-result",
    title: copy("6. Run Human → Robot", "6. 执行人体 → 机器人"),
    body: copy(
      "With a motion, robot, and calibration ready, choose the solver and optional Retarget FPS, then start Retarget. <b>Newton IK</b> handles regular motion; <b>Interaction-Mesh</b> handles clips with interaction objects or terrain.",
      "动作、机器人和标定就绪后，选择求解器与可选的 Retarget FPS，再开始 Retarget。<b>Newton IK</b> 适合常规动作，<b>Interaction-Mesh</b> 适合带交互物体或地形的动作。",
    ),
    placement: "left",
    beforeShow: ({ revealDetails }) => revealDetails("h2r-step-result", true),
    afterLeave: ({ revealDetails }) => revealDetails("h2r-step-result", false),
  },
  {
    id: "view",
    panel: "motion",
    anchor: "#view-hud",
    title: copy("7. Inspect the 3D layers", "7. 检查 3D 显示层"),
    body: copy(
      "Use the stage controls to compare the source skeleton or body, objects and terrain, the calibrated reference, and the retargeted robot. Multiple layers can remain visible for alignment checks.",
      "使用舞台控制项对比源骨架或身体、物体与地形、标定后的参考层以及 Retarget 机器人。多个显示层可以同时打开，便于检查对齐效果。",
    ),
    placement: "bottom",
  },
  {
    id: "export",
    panel: "h2r",
    anchor: "#rt-export-card",
    title: copy("8. Export the result", "8. 导出结果"),
    body: copy(
      "After Retarget finishes, the Result step exposes export controls. Choose CSV or PKL, adjust the output range or FPS when needed, and download the generated trajectory.",
      "Retarget 完成后，结果步骤会显示导出控制项。可以选择 CSV 或 PKL，并按需调整导出区间或 FPS，然后下载生成的轨迹。",
    ),
    placement: "left",
    beforeShow: ({ revealDetails, revealExportCard }) => {
      revealDetails("h2r-step-result", true);
      revealExportCard(true);
    },
    afterLeave: ({ revealDetails, revealExportCard }) => {
      revealExportCard(false);
      revealDetails("h2r-step-result", false);
    },
  },
  {
    id: "done",
    panel: "motion",
    anchor: '[data-menu-trigger="help"]',
    title: copy("9. Tutorial complete", "9. 教程完成"),
    body: copy(
      "The guide is shown automatically only on the first launch. To review it later, open <b>Help → Tutorial</b>. Video → Motion, Robot → Robot, Batch, and Data Analysis are available as separate workspaces in the left navigation.",
      "教程只会在首次启动时自动显示。以后需要复习时，请打开顶部 <b>帮助 → 操作教程</b>。视频 → 动作、机器人 → 机器人、批量处理和数据分析均可从左侧导航进入。",
    ),
    placement: "bottom",
    last: true,
  },
];

function switchPanel(panelId: string | undefined): void {
  if (!panelId) return;
  window.__hhUi?.requestPanel(panelId);
}

export class GuidedTour {
  private readonly _toast: ToastFunction;
  private readonly root: HTMLElement;
  private readonly highlight: HTMLElement;
  private readonly popover: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly stepEl: HTMLElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly skipBtn: HTMLButtonElement;
  private readonly _onResize: () => void;
  private idx = 0;
  private active = false;

  constructor(toastFn: ToastFunction) {
    this._toast = toastFn;
    this.root = document.getElementById("tour-root");
    this.highlight = document.getElementById("tour-highlight");
    this.popover = document.getElementById("tour-popover");
    this.titleEl = document.getElementById("tour-title");
    this.bodyEl = document.getElementById("tour-body");
    this.stepEl = document.getElementById("tour-step");
    this.nextBtn = document.getElementById("tour-next");
    this.skipBtn = document.getElementById("tour-skip");
    this._onResize = () => { if (this.active) this._positionCurrent(); };
    window.addEventListener("resize", this._onResize);
    this.skipBtn?.addEventListener("click", () => this.finish(true));
    this.nextBtn?.addEventListener("click", () => this.next());
  }

  hasBeenShown(): boolean {
    return hasSeenFirstRunTutorial();
  }

  markShown(): void {
    markFirstRunTutorialSeen();
  }

  revealExportCard(on: boolean): void {
    const card = document.getElementById("rt-export-card");
    if (!card) return;
    if (on) {
      if (!card.dataset.tourForced) {
        card.dataset.tourPrevDisplay = card.style.display || "none";
      }
      card.style.display = "block";
      card.dataset.tourForced = "1";
      return;
    }
    if (!card.dataset.tourForced) return;
    card.style.display = card.dataset.tourPrevDisplay || "none";
    delete card.dataset.tourForced;
    delete card.dataset.tourPrevDisplay;
  }

  revealDetails(detailsId: string, on: boolean): void {
    const details = document.getElementById(detailsId);
    if (!(details instanceof HTMLDetailsElement)) return;
    if (on) {
      if (!details.dataset.tourForced) {
        details.dataset.tourWasOpen = details.open ? "1" : "0";
      }
      details.open = true;
      details.dataset.tourForced = "1";
      return;
    }
    if (!details.dataset.tourForced) return;
    details.open = details.dataset.tourWasOpen === "1";
    delete details.dataset.tourForced;
    delete details.dataset.tourWasOpen;
  }

  private _stepCtx(): TourStepContext {
    return {
      revealExportCard: (v) => this.revealExportCard(v),
      revealDetails: (id, v) => this.revealDetails(id, v),
    };
  }

  maybeAutoStart(): void {
    if (this.hasBeenShown()) return;
    // Mark before scheduling so a refresh during the guide does not replay it.
    this.markShown();
    requestAnimationFrame(() => {
      setTimeout(() => this.start(0), 400);
    });
  }

  start(fromIdx = 0): void {
    if (this.active) {
      STEPS[this.idx]?.afterLeave?.(this._stepCtx());
    }
    this.markShown();
    this.idx = fromIdx;
    this.active = true;
    this.root?.classList.add("active");
    document.body.classList.add("tour-active");
    // Panel visibility is reactive in React; mutating CSS classes here would be overwritten.
    window.__hhPanelLayout?.revealBoth();
    this._showStep();
  }

  finish(skipped = false): void {
    this.active = false;
    const step = STEPS[this.idx];
    step?.afterLeave?.(this._stepCtx());
    this.root?.classList.remove("active");
    document.body.classList.remove("tour-active");
    this.highlight?.classList.remove("visible");
    this.popover?.classList.remove("visible");
    this.markShown();
    if (!skipped) this._toast?.(localized(copy("Tutorial complete.", "教程已完成。")));
    else this._toast?.(localized(copy("Tutorial skipped. Reopen it from Help → Tutorial.", "已跳过教程，可从帮助 → 操作教程重新打开。")));
  }

  next(): void {
    const step = STEPS[this.idx];
    step?.afterLeave?.(this._stepCtx());
    if (step?.last) {
      this.finish(false);
      return;
    }
    this.idx += 1;
    this._showStep();
  }

  private _showStep(): void {
    const step = STEPS[this.idx];
    if (!step) {
      this.finish(false);
      return;
    }
    this.highlight?.classList.remove("visible");
    this.popover?.classList.remove("visible");
    switchPanel(step.panel);
    step.beforeShow?.(this._stepCtx());
    // One frame lets React commit the panel change; the second lets the browser
    // calculate its new layout before getBoundingClientRect() is sampled.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this._positionCurrent());
    });
    this.titleEl.textContent = localized(step.title);
    // Tutorial copy is a compile-time constant and intentionally supports only
    // its embedded <b>/<code> markup. Never pass file names or API text here.
    this.bodyEl.innerHTML = localized(step.body);
    this.stepEl.textContent = `${this.idx + 1} / ${STEPS.length}`;
    this.skipBtn.textContent = localized(copy("Skip tutorial", "跳过教程"));
    this.nextBtn.textContent = step.last
      ? localized(copy("Finish", "完成"))
      : localized(copy("Next", "下一步"));
  }

  private _positionCurrent(): void {
    const step = STEPS[this.idx];
    if (!step) return;
    const el = document.querySelector(step.anchor);
    if (!el) {
      this._centerPopover();
      return;
    }
    el.scrollIntoView({ block: "nearest", behavior: "auto" });
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this._centerPopover();
      return;
    }
    const pad = 8;
    const h = this.highlight;
    h.style.left = `${Math.max(0, rect.left - pad)}px`;
    h.style.top = `${Math.max(0, rect.top - pad)}px`;
    h.style.width = `${rect.width + pad * 2}px`;
    h.style.height = `${rect.height + pad * 2}px`;
    h.classList.add("visible");

    const pop = this.popover;
    const margin = 14;
    const pw = pop.offsetWidth || 320;
    const ph = pop.offsetHeight || 160;
    let left = 0;
    let top = 0;
    if (step.placement === "left") {
      left = rect.left - pw - margin;
      top = rect.top + rect.height / 2 - ph / 2;
    } else if (step.placement === "right") {
      left = rect.right + margin;
      top = rect.top + rect.height / 2 - ph / 2;
    } else if (step.placement === "top") {
      left = rect.left + rect.width / 2 - pw / 2;
      top = rect.top - ph - margin;
    } else {
      left = rect.left + rect.width / 2 - pw / 2;
      top = rect.bottom + margin;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    left = Math.min(vw - pw - 12, Math.max(12, left));
    top = Math.min(vh - ph - 12, Math.max(56, top));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.classList.add("visible");
  }

  private _centerPopover(): void {
    this.highlight?.classList.remove("visible");
    const pop = this.popover;
    const pw = pop.offsetWidth || 320;
    const ph = pop.offsetHeight || 160;
    pop.style.left = `${Math.max(12, (window.innerWidth - pw) / 2)}px`;
    pop.style.top = `${Math.max(56, (window.innerHeight - ph) / 2)}px`;
    pop.classList.add("visible");
  }
}

export function initTutorial(toastFn: ToastFunction): GuidedTour {
  const tour = new GuidedTour(toastFn);
  // Help-menu commands use this narrow global bridge to restart the singleton.
  window.__hhTour = tour;
  return tour;
}
