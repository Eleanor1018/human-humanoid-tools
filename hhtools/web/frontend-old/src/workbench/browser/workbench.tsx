import { useCallback, useEffect, useMemo, useState } from "react";

import { AboutDialog } from "./components/about-dialog";
import {
  CommandPalette,
  DesktopMenuBar,
} from "./components/application-chrome";
import {
  BatchStage,
  BatchWorkflow,
  type BatchMode,
} from "./components/batch-workflow";
import { DataAnalysisPanel } from "./components/data-analysis-panel";
import { HumanToRobotWorkflow } from "./components/human-to-robot-workflow";
import { JobDrawer } from "./components/job-drawer";
import { MotionPanel } from "./components/motion-panel";
import { RobotAssetsPanel } from "./components/robot-assets-panel";
import { RobotToRobotWorkflow } from "./components/robot-to-robot-workflow";
import { SidebarNavigation } from "./components/sidebar-navigation";
import { ThreeStage } from "./components/three-stage";
import { WorkspaceDrawerHandle } from "./components/workspace-drawer-handle";
import { WorkspaceSettingsDialog } from "./components/workspace-settings-dialog";
import { usePanelLayout } from "./use-panel-layout";
import { useVideoBatch } from "./use-video-batch";
import { useWorkbenchServices } from "./workbench-service-context";
import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import { windowEventBus } from "@/platform/events/browser/window-event-bus";
import type {
  GvhmrRuntimeStatus,
  ImportCommandTarget,
  JobAdmissionSettings,
  JobAdmissionSnapshot,
  MotionLibrarySettingsSnapshot,
} from "@/runtime/types";
import type { WorkbenchPanelContribution } from "@/workbench/common/panel-contribution";
import type {
  WorkspaceLocale,
  WorkspacePanelId,
  WorkspaceTheme,
} from "@/workbench/common/workspace";
import {
  loadWorkspacePreferences,
  updateWorkspacePreferences,
} from "@/runtime/workspace-preferences";
import { cn } from "@/lib/utils";
import { WorkbenchCommandIds } from "@/workbench/common/command-ids";
import type { GvhmrOptionalComponentState } from "@/workbench/services/gvhmr/common/gvhmr-component-service";
import type {
  ThreeStageRendererMount,
} from "@/workbench/browser/stage/three-stage-renderer-mount";

// Unmigrated command-palette imports still resolve to compatibility elements.
// Migrated features such as V2M register commands instead of entering this map.
const importTargets: Record<
  Exclude<ImportCommandTarget, "video-file">,
  {
    panel: WorkspacePanelId;
    selector: string;
    motionProfile?: "mimic" | "intermimic" | "meshmimic";
  }
> = {
  "motion-file": {
    panel: "motion",
    selector: "#motion-pick-file",
    motionProfile: "mimic",
  },
  "motion-folder": {
    panel: "motion",
    selector: "#motion-pick-folder",
    motionProfile: "mimic",
  },
  "robot-urdf": { panel: "robot-assets", selector: "#robot-pick-urdf" },
  "robot-mesh-folder": {
    panel: "robot-assets",
    selector: "#robot-pick-mesh-folder",
  },
};

/**
 * Application shell, comparable to VS Code's workbench surface.
 *
 * Ownership is intentionally split:
 * - React owns navigation, dialogs, layout, and migrated view-model state.
 * - platform/services own host capabilities and HTTP/event boundaries.
 * - the compatibility runtime still owns Three.js and unmigrated IK workflows
 *   until those domain slices are migrated behind dedicated services.
 *
 * Both FastAPI WebUI and Electron instantiate this exact component tree.
 */
interface WorkbenchProps {
  panelContributions: readonly WorkbenchPanelContribution[];
  stageRendererMount: ThreeStageRendererMount | null;
}

export function Workbench({
  panelContributions,
  stageRendererMount,
}: WorkbenchProps) {
  // These concrete implementations are assembled in main.tsx; the shell only
  // sees their stable interfaces. Remaining window bridges below are explicit
  // migration seams, not members of the new service graph.
  const {
    commandService,
    gvhmrComponentService,
    hostService,
    stageDisplayCommands,
    stageLayerCommands,
    stageModelService,
    stagePlaybackCommands,
    settingsService,
  } = useWorkbenchServices();
  const initial = useMemo(() => loadWorkspacePreferences(), []);
  const [activePanel, setActivePanelState] = useState<WorkspacePanelId>(
    initial.activePanel,
  );
  const [locale, setLocaleState] = useState<WorkspaceLocale>(initial.locale);
  const [theme, setThemeState] = useState<WorkspaceTheme>(initial.theme);
  const [batchMode, setBatchMode] = useState<BatchMode>("h2r");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [jobAdmission, setJobAdmission] = useState<JobAdmissionSnapshot | null>(
    null,
  );
  const [motionLibrary, setMotionLibrary] =
    useState<MotionLibrarySettingsSnapshot | null>(null);
  const [gvhmrComponent, setGvhmrComponent] =
    useState<GvhmrOptionalComponentState | null>(null);
  const [gvhmrRuntime, setGvhmrRuntime] = useState<GvhmrRuntimeStatus | null>(
    null,
  );
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const layout = usePanelLayout();
  const videoBatch = useVideoBatch(locale);
  const text = useLocaleText(locale);

  const setActivePanel = useCallback((requested: string) => {
    const panel = (
      requested === "robot"
        ? "h2r"
        : requested === "video"
          ? "video-to-motion"
          : requested
    ) as WorkspacePanelId;
    setActivePanelState(panel);
    updateWorkspacePreferences({ activePanel: panel });
  }, []);
  /**
   * User-facing navigation enters through one event consumer below. Once the
   * compatibility runtime is ready, that consumer delegates to its exact
   * presentation coordinator; the coordinator alone calls `setActivePanel`
   * while transferring shared Stage ownership. Before runtime activation the
   * same consumer falls back to local React state so navigation remains live.
   */
  const requestPanel = useCallback((panel: string) => {
    windowEventBus.emit("hhtools:panel-request", panel);
  }, []);
  const setLocale = (next: WorkspaceLocale) => {
    setLocaleState(next);
    document.documentElement.lang = next;
    updateWorkspacePreferences({ locale: next });
    requestAnimationFrame(() =>
      window.dispatchEvent(new Event("hhtools:workspace-locale-change")),
    );
  };
  const setTheme = (next: WorkspaceTheme) => {
    setThemeState(next);
    document.documentElement.dataset.theme = next;
    updateWorkspacePreferences({ theme: next });
  };
  const refreshSettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const [jobs, library, optional, gvhmr] = await Promise.all([
        settingsService.getJobAdmission(),
        settingsService.getMotionLibrary(),
        gvhmrComponentService.getState(),
        settingsService.getGvhmrRuntime().catch(() => null),
      ]);
      setJobAdmission(jobs);
      setMotionLibrary(library);
      setGvhmrComponent(optional);
      setGvhmrRuntime(gvhmr);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsLoading(false);
    }
  }, [gvhmrComponentService, settingsService]);

  const chooseMotionLibrary = useCallback(async () => {
    if (settingsSaving) return;
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      // A cancelled native picker is final. Browser mode alone falls back to a
      // server-path prompt because browsers cannot reveal absolute directories.
      const selected = hostService.isDesktop
        ? await hostService.selectDirectory()
        : window.prompt(
            text(
              "Enter the library directory on the server",
              "输入服务器上的资源库目录",
            ),
            motionLibrary?.root || "",
          );
      if (!selected?.trim()) return;
      const saved = await settingsService.saveMotionLibrary(selected.trim());
      setMotionLibrary(saved);
      await window.__hhApp?.refreshLibrary();
      window.__hhApp?.toast(
        text(
          `Library directory changed: ${saved.root}`,
          `资源库目录已切换：${saved.root}`,
        ),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setSettingsError(message);
      window.__hhApp?.toast(message, true);
    } finally {
      setSettingsSaving(false);
    }
  }, [motionLibrary?.root, settingsSaving, text]);

  const saveJobs = async (value: JobAdmissionSettings) => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      setJobAdmission(await settingsService.saveJobAdmission(value));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };
  const setupGvhmr = async () => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const result = await gvhmrComponentService.setup();
      if (!result) return;
      setGvhmrComponent(result.state);
      await refreshSettings();
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.theme = theme;
    window.__hhUi = {
      setActivePanel,
      requestPanel,
    };
    const panelSubscription = windowEventBus.on(
      "hhtools:panel-request",
      (event) => {
        const runtimePanelSwitch = window.__hhApp?.switchInspectorPanel;
        if (runtimePanelSwitch) runtimePanelSwitch(event.detail);
        else setActivePanel(event.detail);
      },
    );
    const importSubscription = windowEventBus.on(
      "hhtools:import-command",
      (event) => {
        if (event.detail.target === "video-file") {
          // The contributed V2M view stays mounted and owns this command.
          // Request the panel first so leaving R2R also returns Stage ownership,
          // then invoke intent without knowing the contributed View's DOM.
          requestPanel("video-to-motion");
          void commandService
            .executeCommand(WorkbenchCommandIds.pickVideoToMotionSource)
            .catch(() =>
              window.__hhApp?.toast(
                text(
                  "The import entry point is not ready yet. Try again shortly.",
                  "导入入口尚未准备完成，请稍后重试",
                ),
                true,
              ),
            );
          return;
        }
        const target = importTargets[event.detail.target];
        if (target.motionProfile)
          windowEventBus.emit(
            "hhtools:motion-profile-request",
            target.motionProfile,
          );
        requestPanel(target.panel);
        requestAnimationFrame(() => {
          const button = document.querySelector<HTMLButtonElement>(
            target.selector,
          );
          if (button) button.click();
          else
            window.__hhApp?.toast(
              text(
                "The import entry point is not ready yet. Try again shortly.",
                "导入入口尚未准备完成，请稍后重试",
              ),
              true,
            );
        });
      },
    );
    void settingsService
      .getMotionLibrary()
      .then(setMotionLibrary)
      .catch(() => undefined);
    return () => {
      panelSubscription.dispose();
      importSubscription.dispose();
      delete window.__hhUi;
    };
  }, [
    commandService,
    locale,
    requestPanel,
    setActivePanel,
    settingsService,
    text,
    theme,
  ]);

  const applicationChrome = {
    activePanel,
    locale,
    theme,
    stageDisplayCommands,
    stageModelService,
    onOpenSettings: () => {
      setSettingsOpen(true);
      void refreshSettings();
    },
    onOpenAbout: () => setAboutOpen(true),
    onToggleTheme: () => setTheme(theme === "light" ? "dark" : "light"),
  };
  return (
    <>
      <div
        id="app"
        className={cn(
          "workspace-shell",
          hostService.isDesktop ? "electron-host" : "web-host",
          layout.state.sidebarHidden && "sidebar-hidden",
          layout.state.inspectorHidden && "inspector-hidden",
        )}
        style={layout.style}
      >
        <header id="topbar">
          <div className="logo">
            <img
              className="desktop-logo-mark"
              src="/hhtools-robot.svg"
              alt=""
            />
            <span className="desktop-brand-name">HHTOOLS</span>
            <span hidden className="ui-build" id="ui-build">
              UI·react
            </span>
          </div>
          <DesktopMenuBar {...applicationChrome} />
          <div className="spacer" />
          <CommandPalette {...applicationChrome} />
          <span hidden className="pill" id="motion-pill">
            —
          </span>
          <span hidden className="pill" id="robot-pill">
            —
          </span>
        </header>
        <nav
          id="sidebar"
          className="side-panel"
          aria-label={text("Navigation", "导航")}
          aria-hidden={layout.state.sidebarHidden}
          inert={layout.state.sidebarHidden}
        >
          <div id="sidebar-body">
            <SidebarNavigation
              activePanel={activePanel}
              locale={locale}
              onRequest={requestPanel}
            />
          </div>
        </nav>
        <div
          className="col-resizer"
          id="resize-sidebar"
          title={text("Drag to resize the navigation", "拖动调节左栏宽度")}
          onPointerDown={(event) => layout.startResize("sidebar", event)}
        />
        <WorkspaceDrawerHandle
          side="left"
          expanded={!layout.state.sidebarHidden}
          locale={locale}
          onToggle={() =>
            layout.setHidden("sidebar", !layout.state.sidebarHidden)
          }
        />
        <ThreeStage
          locale={locale}
          stageDisplayCommands={stageDisplayCommands}
          stageLayerCommands={stageLayerCommands}
          stageModelService={stageModelService}
          stagePlaybackCommands={stagePlaybackCommands}
          stageRendererMount={stageRendererMount}
          batchActive={activePanel === "batch"}
          batchWorkspace={
            <BatchStage
              active={activePanel === "batch"}
              mode={batchMode}
              locale={locale}
              videoBatch={videoBatch}
            />
          }
        />
        <div
          className="col-resizer"
          id="resize-inspector"
          title={text("Drag to resize the inspector", "拖动调节右栏宽度")}
          onPointerDown={(event) => layout.startResize("inspector", event)}
        />
        <aside
          id="inspector"
          className="side-panel"
          aria-label={text("Inspector", "控制面板")}
          aria-hidden={layout.state.inspectorHidden}
          inert={layout.state.inspectorHidden}
        >
          <div id="inspector-body">
            <MotionPanel
              active={activePanel === "motion"}
              locale={locale}
              settings={motionLibrary}
              settingsBusy={settingsLoading || settingsSaving}
              onChooseLibrary={() => void chooseMotionLibrary()}
            />
            {/* Inactive workflows stay mounted during the migration. The
                compatibility runtime retains listeners and element references,
                so unmounting here would break the next panel switch. */}
            {panelContributions.map(({ id, component: Panel }) => (
              <section
                key={id}
                className={cn(
                  "panel",
                  activePanel === id && "active",
                )}
                data-panel={id}
              >
                <Panel locale={locale} requestPanel={requestPanel} />
              </section>
            ))}
            <section
              className={cn(
                "panel",
                (activePanel === "robot-assets" || activePanel === "h2r") &&
                  "active",
              )}
              data-panel="robot"
            >
              <div
                style={{
                  display: activePanel === "robot-assets" ? undefined : "none",
                }}
              >
                <RobotAssetsPanel locale={locale} />
              </div>
              <div
                style={{ display: activePanel === "h2r" ? undefined : "none" }}
              >
                <HumanToRobotWorkflow
                  locale={locale}
                  onRequestPanel={requestPanel}
                />
              </div>
            </section>
            <section
              className={cn("panel", activePanel === "batch" && "active")}
              data-panel="batch"
            >
              <BatchWorkflow
                mode={batchMode}
                onModeChange={setBatchMode}
                locale={locale}
                onRequestPanel={requestPanel}
                videoBatch={videoBatch}
              />
            </section>
            <section
              className={cn("panel", activePanel === "r2r" && "active")}
              data-panel="r2r"
            >
              <RobotToRobotWorkflow
                locale={locale}
                onRequestPanel={requestPanel}
              />
            </section>
            <section
              className={cn(
                "panel panel-dataset-viz",
                activePanel === "dataset-viz" && "active",
              )}
              data-panel="dataset-viz"
            >
              <DataAnalysisPanel locale={locale} />
            </section>
          </div>
        </aside>
        <WorkspaceDrawerHandle
          side="right"
          expanded={!layout.state.inspectorHidden}
          locale={locale}
          onToggle={() =>
            layout.setHidden("inspector", !layout.state.inspectorHidden)
          }
        />
        <JobDrawer locale={locale} />
      </div>
      <WorkspaceSettingsDialog
        open={settingsOpen}
        locale={locale}
        sidebarHidden={layout.state.sidebarHidden}
        inspectorHidden={layout.state.inspectorHidden}
        jobAdmission={jobAdmission}
        motionLibrary={motionLibrary}
        gvhmrComponent={gvhmrComponent}
        gvhmrRuntime={gvhmrRuntime}
        loading={settingsLoading}
        saving={settingsSaving}
        error={settingsError}
        onOpenChange={setSettingsOpen}
        onSetLocale={setLocale}
        onSetHidden={layout.setHidden}
        onReset={layout.reset}
        onSaveJobs={(value) => void saveJobs(value)}
        onChooseLibrary={() => void chooseMotionLibrary()}
        onSetupGvhmr={() => void setupGvhmr()}
        onRefresh={() => void refreshSettings()}
      />
      <AboutDialog
        open={aboutOpen}
        locale={locale}
        onOpenChange={setAboutOpen}
      />
      <RuntimeOverlays locale={locale} />
    </>
  );
}

/**
 * Lifecycle-stable compatibility ports for global feedback.
 * React owns these nodes; the existing runtime temporarily owns their text,
 * classes, and progress. Producer and view should migrate together later.
 */
function RuntimeOverlays({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  return (
    <>
      <div id="load-overlay" className="hidden">
        <div className="load-card">
          <div className="load-label" id="load-label">
            {text("Loading…", "加载中…")}
          </div>
          <div className="progress">
            <div className="bar" id="load-bar" />
          </div>
          <div className="load-sub" id="load-sub" />
        </div>
      </div>
      <div id="calib-banner" className="hidden">
        <span className="dot" />
        {text(
          "Calibration mode · Align the robot to the reference skeleton",
          "标定模式 · 请将机器人对齐到参考骨架",
        )}
      </div>
      <div id="tour-root" className="tour-root" aria-hidden="true">
        <div id="tour-highlight" className="tour-highlight" />
        <div
          id="tour-popover"
          className="tour-popover"
          role="dialog"
          aria-labelledby="tour-title"
        >
          <div className="tour-popover-head">
            <span className="tour-step-badge" id="tour-step">
              1 / 9
            </span>
            <button type="button" className="tour-skip" id="tour-skip">
              {text("Skip tutorial", "跳过教程")}
            </button>
          </div>
          <h3 className="tour-title" id="tour-title">
            {text("Tutorial", "操作教程")}
          </h3>
          <p className="tour-body" id="tour-body" />
          <button type="button" className="btn tour-next" id="tour-next">
            {text("Next", "下一步")}
          </button>
        </div>
      </div>
      <div id="toast" />
      <div
        id="boot-error"
        style={{
          display: "none",
          position: "fixed",
          inset: "auto 16px 16px",
          zIndex: 200,
          background: "#ff3b30",
          color: "#fff",
          padding: "12px 16px",
          borderRadius: 8,
        }}
      />
    </>
  );
}
