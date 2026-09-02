import { useEffect, useMemo, useState } from "react";

import { SearchField } from "@/workbench/browser/components/search-field";
import type {
  LibraryAssetKind,
  LibraryEntry,
  MotionCategory,
} from "@/runtime/types";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import { cn } from "@/lib/utils";

type MotionPickerMode = "load" | "basket";
type MotionPickerCategory = "all" | MotionCategory;

interface MotionPickerDialogProps {
  open: boolean;
  locale: WorkspaceLocale;
  mode?: MotionPickerMode;
  assetKind?: LibraryAssetKind;
  onClose(): void;
  onImport(options?: { folder?: boolean }): void;
  onSelected?(entry: LibraryEntry): void;
}

function normalizedAssetKind(entry: LibraryEntry): LibraryAssetKind {
  // Older library entries predate asset_kind; infer it so upgraded libraries
  // remain selectable without a data migration.
  if (entry.asset_kind) return entry.asset_kind;
  return entry.dataset === "robot" || entry.dataset === "r2r"
    ? "robot_trajectory"
    : "human_motion";
}

function normalizedCategory(entry: LibraryEntry): MotionCategory {
  return entry.motion_category === "object" ||
    entry.motion_category === "terrain"
    ? entry.motion_category
    : "motion";
}

/**
 * Shared library picker for H2R, R2R, and Batch.
 * `load` commits one entry immediately, while `basket` keeps a local Map until
 * the user confirms. A source-path-derived key keeps selection stable across
 * filtering without mutating API response objects.
 */
export function MotionPickerDialog({
  open,
  locale,
  mode = "load",
  assetKind = "human_motion",
  onClose,
  onImport,
  onSelected,
}: MotionPickerDialogProps) {
  const text = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const robot = assetKind === "robot_trajectory";
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MotionPickerCategory>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectingKey, setSelectingKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selection, setSelection] = useState<Map<string, LibraryEntry>>(
    new Map(),
  );

  const title = (entry: LibraryEntry) =>
    entry.stem ||
    entry.sequence_id ||
    entry.display_name ||
    entry.name ||
    text("Untitled motion", "未命名动作");
  const context = (entry: LibraryEntry) =>
    entry.folder_label || entry.dataset || text("Motion Library", "动作资源库");
  const key = (entry: LibraryEntry) =>
    entry.source_path || `${context(entry)}/${title(entry)}`;
  const categoryLabel = (value: MotionCategory) =>
    value === "object"
      ? text(robot ? "Interaction" : "Object", robot ? "交互" : "物体")
      : value === "terrain"
        ? text("Terrain", "地形")
        : text(robot ? "Trajectory" : "Motion", robot ? "轨迹" : "动作");

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      if (!window.__hhApp)
        throw new Error(
          text("The motion runtime is not ready yet.", "动作运行时尚未就绪。"),
        );
      const response = await window.__hhApp.API.get("/api/library");
      setEntries(
        (response.entries || []).filter(
          (entry) => normalizedAssetKind(entry) === assetKind,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCategory("all");
    setSelection(new Map());
    void refresh();
    const focusTimer = window.setTimeout(() =>
      document.getElementById("motion-picker-search")?.focus(),
    );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", keydown);
    };
    // Opening starts a new picker session. Callback identity is intentionally
    // not part of that lifecycle because parents often render inline handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, assetKind]);

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
      const entryCategory = normalizedCategory(entry);
      if (category !== "all" && category !== entryCategory) return false;
      const haystack = [
        entry.folder_label,
        entry.dataset,
        entry.stem,
        entry.sequence_id,
        entry.display_name,
        entry.name,
        entryCategory,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [category, entries, query]);

  if (!open) return null;

  const select = async (entry: LibraryEntry): Promise<void> => {
    const entryKey = key(entry);
    if (mode === "basket") {
      setSelection((current) => {
        const next = new Map(current);
        if (next.has(entryKey)) next.delete(entryKey);
        else next.set(entryKey, entry);
        return next;
      });
      return;
    }
    if (!window.__hhApp || selectingKey) return;
    setSelectingKey(entryKey);
    setError(null);
    try {
      if (robot) await window.__hhApp.loadR2rLibraryEntry(entry);
      else await window.__hhApp.loadHumanMotionEntry(entry);
      onSelected?.(entry);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSelectingKey(null);
    }
  };

  const addSelected = async (): Promise<void> => {
    if (!window.__hhApp || selection.size === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const selected = [...selection.values()];
      await window.__hhApp.addToBasket(selected);
      selected.forEach((entry) => onSelected?.(entry));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="motion-picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="motion-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="motion-picker-title"
      >
        <header className="motion-picker-head">
          <h2 id="motion-picker-title">
            {robot
              ? text("Select source trajectory", "选择源轨迹")
              : mode === "basket"
                ? text("Add motions", "添加动作")
                : text("Select motion", "选择动作")}
          </h2>
          <button
            type="button"
            className="motion-picker-close"
            aria-label={text("Close motion picker", "关闭动作选择窗口")}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="motion-picker-tools">
          <SearchField
            id="motion-picker-search"
            value={query}
            onValueChange={setQuery}
            label={text("Search motions", "搜索动作")}
            placeholder={text(
              "Search by motion or dataset…",
              "按动作或数据集搜索……",
            )}
            clearLabel={text("Clear search", "清除搜索")}
          />
          <select
            className="search motion-picker-filter"
            value={category}
            onChange={(event) =>
              setCategory(event.currentTarget.value as MotionPickerCategory)
            }
            aria-label={text("Filter by motion type", "按动作类型筛选")}
          >
            <option value="all">{text("All types", "全部类型")}</option>
            <option value="motion">
              {text(robot ? "Trajectory" : "Motion", robot ? "轨迹" : "动作")}
            </option>
            <option value="object">
              {text(robot ? "Interaction" : "Object", robot ? "交互" : "物体")}
            </option>
            <option value="terrain">{text("Terrain", "地形")}</option>
          </select>
        </div>
        <div
          className="motion-picker-list"
          role="listbox"
          aria-busy={loading}
          aria-multiselectable={mode === "basket" || undefined}
        >
          {loading && (
            <p className="motion-picker-message">
              {text("Loading motions…", "正在读取动作……")}
            </p>
          )}
          {!loading && error && (
            <div className="motion-picker-message error">
              <span>{error}</span>
              <button
                type="button"
                className="btn secondary small"
                onClick={() => void refresh()}
              >
                {text("Retry", "重试")}
              </button>
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <p className="motion-picker-message">
              {text(
                robot
                  ? "No robot trajectories are available."
                  : "The Motion Library is empty.",
                robot ? "暂无可用的机器人轨迹。" : "动作资源库为空。",
              )}
            </p>
          )}
          {!loading &&
            !error &&
            entries.length > 0 &&
            filtered.length === 0 && (
              <p className="motion-picker-message">
                {text("No matching motions.", "没有匹配的动作。")}
              </p>
            )}
          {!loading &&
            !error &&
            filtered.slice(0, 300).map((entry) => {
              const entryKey = key(entry);
              const selected = selection.has(entryKey);
              return (
                <button
                  key={entryKey}
                  type="button"
                  className={cn(
                    "motion-picker-row",
                    mode === "basket" && selected && "is-selected",
                  )}
                  role="option"
                  aria-selected={mode === "basket" ? selected : undefined}
                  disabled={selectingKey !== null || submitting}
                  onClick={() => void select(entry)}
                >
                  <span className="motion-picker-row-copy">
                    <strong>{title(entry)}</strong>
                    <small>{context(entry)}</small>
                  </span>
                  <span
                    className="motion-picker-category"
                    data-category={normalizedCategory(entry)}
                  >
                    {categoryLabel(normalizedCategory(entry))}
                  </span>
                  <span className="motion-picker-action">
                    {mode === "basket"
                      ? text(
                          selected ? "Selected" : "Select",
                          selected ? "已选择" : "选择",
                        )
                      : selectingKey === entryKey
                        ? text("Loading…", "加载中……")
                        : text("Select", "选择")}
                  </span>
                </button>
              );
            })}
        </div>
        <footer className="motion-picker-actions">
          <div className="workflow-button-row">
            <button
              type="button"
              className="btn secondary small"
              onClick={() => {
                onImport({ folder: false });
                onClose();
              }}
            >
              {text(
                robot ? "Import file" : "Import motion",
                robot ? "导入文件" : "导入动作",
              )}
            </button>
            {robot && (
              <button
                type="button"
                className="btn secondary small"
                onClick={() => {
                  onImport({ folder: true });
                  onClose();
                }}
              >
                {text("Import folder", "导入文件夹")}
              </button>
            )}
          </div>
          {mode === "basket" ? (
            <div className="motion-picker-basket-actions">
              <span className="motion-picker-selection-count" role="status">
                {text(
                  `${selection.size} selected`,
                  `已选择 ${selection.size} 条`,
                )}
              </span>
              <button
                type="button"
                className="btn secondary small"
                onClick={onClose}
              >
                {text("Cancel", "取消")}
              </button>
              <button
                type="button"
                className="btn small motion-picker-add-selected"
                disabled={selection.size === 0 || submitting}
                onClick={() => void addSelected()}
              >
                {submitting
                  ? text("Adding…", "正在添加……")
                  : text(
                      `Add ${selection.size}`,
                      `添加 ${selection.size} 条动作`,
                    )}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn secondary small"
              onClick={onClose}
            >
              {text("Cancel", "取消")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
