import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  GvhmrOptionalComponentState,
  GvhmrRuntimeStatus,
  JobAdmissionSettings,
  JobAdmissionSnapshot,
  MotionLibrarySettingsSnapshot,
  WorkspaceLocale,
} from "@/runtime/types";

interface WorkspaceSettingsDialogProps {
  open: boolean;
  locale: WorkspaceLocale;
  sidebarHidden: boolean;
  inspectorHidden: boolean;
  jobAdmission: JobAdmissionSnapshot | null;
  motionLibrary: MotionLibrarySettingsSnapshot | null;
  gvhmrComponent: GvhmrOptionalComponentState | null;
  gvhmrRuntime: GvhmrRuntimeStatus | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onOpenChange(open: boolean): void;
  onSetLocale(locale: WorkspaceLocale): void;
  onSetHidden(side: "sidebar" | "inspector", hidden: boolean): void;
  onReset(): void;
  onSaveJobs(settings: JobAdmissionSettings): void;
  onChooseLibrary(): void;
  onSetupGvhmr(): void;
  onRefresh(): void;
}

/** Settings editor is intentionally controlled so effective server state lives at workbench scope. */
export function WorkspaceSettingsDialog(props: WorkspaceSettingsDialogProps) {
  const text = (en: string, zh: string) => (props.locale === "zh-CN" ? zh : en);
  const [running, setRunning] = useState("0");
  const [queued, setQueued] = useState("0");
  useEffect(() => {
    if (!props.jobAdmission) return;
    setRunning(String(props.jobAdmission.max_running_jobs));
    setQueued(String(props.jobAdmission.max_queued_jobs));
  }, [props.jobAdmission, props.open]);
  const parsed = { running: Number(running), queued: Number(queued) };
  const valid =
    Number.isSafeInteger(parsed.running) &&
    parsed.running >= 0 &&
    Number.isSafeInteger(parsed.queued) &&
    parsed.queued >= 0;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="workspace-settings-dialog max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle id="workspace-settings-title">
            {text("Workspace Settings", "工作区设置")}
          </DialogTitle>
          <DialogDescription>
            {text(
              "Language, layout, libraries, and background jobs",
              "语言、布局、资源库与后台任务",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="workspace-settings-body">
          <div className="workspace-settings-section-head">
            {text("Workspace", "工作区")}
          </div>
          <label className="workspace-setting-row">
            <span>
              <strong>{text("Language", "语言")}</strong>
              <small>
                {text("Menus and navigation language", "设置菜单和导航语言")}
              </small>
            </span>
            <select
              className="workspace-language-select"
              value={props.locale}
              onChange={(event) =>
                props.onSetLocale(event.currentTarget.value as WorkspaceLocale)
              }
            >
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <label className="workspace-setting-row">
            <span>
              <strong>{text("Left navigation", "左侧导航")}</strong>
            </span>
            <input
              type="checkbox"
              checked={!props.sidebarHidden}
              onChange={(event) =>
                props.onSetHidden("sidebar", !event.currentTarget.checked)
              }
            />
          </label>
          <label className="workspace-setting-row">
            <span>
              <strong>{text("Right inspector", "右侧控制面板")}</strong>
            </span>
            <input
              type="checkbox"
              checked={!props.inspectorHidden}
              onChange={(event) =>
                props.onSetHidden("inspector", !event.currentTarget.checked)
              }
            />
          </label>
          <div className="workspace-settings-section-head">
            <span>{text("Motion library", "动作资源库")}</span>
            <small>
              {text(
                "Changes apply immediately; existing files are not moved.",
                "修改立即生效，原目录内容不会移动。",
              )}
            </small>
          </div>
          <div className="workspace-setting-row workspace-library-setting-row">
            <span>
              <strong>{text("Library directory", "资源库目录")}</strong>
              <code className="workspace-library-root">
                {props.motionLibrary?.root || "—"}
              </code>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={props.saving || props.motionLibrary?.editable !== true}
              onClick={props.onChooseLibrary}
            >
              {text("Choose directory", "选择目录")}
            </Button>
          </div>
          {props.gvhmrComponent && (
            <>
              <div className="workspace-settings-section-head">
                <span>{text("Optional components", "可选组件")}</span>
              </div>
              <div className="workspace-setting-row">
                <span>
                  <strong>
                    {text("GVHMR video-to-motion", "GVHMR 视频转动作")}
                  </strong>
                  <small>
                    {props.gvhmrRuntime?.ready
                      ? text("Ready", "已就绪")
                      : props.gvhmrRuntime?.missing?.slice(0, 2).join(" · ") ||
                        text("Needs configuration", "需要配置")}
                  </small>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={props.saving}
                  onClick={props.onSetupGvhmr}
                >
                  {text("Set up / repair", "配置 / 修复")}
                </Button>
              </div>
            </>
          )}
          <div className="workspace-settings-section-head">
            <span>{text("Background-job scheduling", "后台任务调度")}</span>
          </div>
          <label className="workspace-setting-row workspace-setting-number-row">
            <span>
              <strong>{text("Maximum running jobs", "最大并发任务数")}</strong>
              <small>{text("0 means unlimited", "0 表示不限")}</small>
            </span>
            <input
              className="workspace-number-input"
              type="number"
              min="0"
              value={running}
              disabled={
                props.loading ||
                props.saving ||
                props.jobAdmission?.editable !== true
              }
              onChange={(event) => setRunning(event.currentTarget.value)}
            />
          </label>
          <label className="workspace-setting-row workspace-setting-number-row">
            <span>
              <strong>{text("Maximum queued jobs", "最大等待任务数")}</strong>
              <small>{text("0 means unlimited", "0 表示不限")}</small>
            </span>
            <input
              className="workspace-number-input"
              type="number"
              min="0"
              value={queued}
              disabled={
                props.loading ||
                props.saving ||
                props.jobAdmission?.editable !== true
              }
              onChange={(event) => setQueued(event.currentTarget.value)}
            />
          </label>
          {!valid && (
            <p className="workspace-settings-message error" role="alert">
              {text(
                "Enter integers greater than or equal to 0.",
                "请输入 0 或更大的整数。",
              )}
            </p>
          )}
          {props.error && (
            <p className="workspace-settings-message error" role="alert">
              {props.error}
            </p>
          )}
        </div>
        <footer className="workspace-settings-actions">
          <Button variant="ghost" onClick={props.onReset}>
            {text("Reset layout", "重置布局")}
          </Button>
          <div className="workspace-settings-primary-actions">
            <Button variant="outline" onClick={props.onRefresh}>
              {text("Refresh", "刷新")}
            </Button>
            <Button
              disabled={
                !valid || props.saving || props.jobAdmission?.editable !== true
              }
              onClick={() =>
                props.onSaveJobs({
                  max_running_jobs: parsed.running,
                  max_queued_jobs: parsed.queued,
                })
              }
            >
              {props.saving ? text("Saving…", "保存中…") : text("Save", "保存")}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
