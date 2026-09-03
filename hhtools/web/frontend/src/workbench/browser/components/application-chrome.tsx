import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import {
  createApplicationCommands,
  DESKTOP_MENUS,
  type ApplicationCommand,
  type DesktopMenuId,
} from "@/runtime/command-registry";
import type {
  WorkspaceLocale,
  WorkspacePanelId,
  WorkspaceTheme,
} from "@/workbench/common/workspace";
import { useStageCanResetView } from "@/workbench/services/stage/browser/use-stage-model-state";
import type {
  IStageDisplayCommands,
  IStageModelService,
} from "@/workbench/services/stage/common/stage-service";
import { cn } from "@/lib/utils";

interface ApplicationChromeProps {
  activePanel: WorkspacePanelId;
  locale: WorkspaceLocale;
  theme: WorkspaceTheme;
  stageDisplayCommands: IStageDisplayCommands;
  stageModelService: IStageModelService;
  onOpenSettings(): void;
  onOpenAbout(): void;
  onToggleTheme(): void;
}

function useApplicationCommands(
  props: ApplicationChromeProps,
): ApplicationCommand[] {
  const modelCanResetView = useStageCanResetView(props.stageModelService);
  // Batch temporarily replaces the visual Stage, so its hidden 3D renderer is
  // not an active Reset target even when it still retains loaded content.
  const canResetView = modelCanResetView && props.activePanel !== "batch";
  const resetView = useCallback(
    () => props.stageDisplayCommands.resetView(),
    [props.stageDisplayCommands],
  );

  // Menus and Ctrl+K are projections of one registry. Adding a command there
  // keeps every implemented command surface aligned.
  return useMemo(
    () =>
      createApplicationCommands({
        activePanel: props.activePanel,
        locale: props.locale,
        theme: props.theme,
        applicationMode: true,
        openSettings: props.onOpenSettings,
        openAbout: props.onOpenAbout,
        toggleTheme: props.onToggleTheme,
        canExitApplication: window.hhtoolsDesktop !== undefined,
        exitApplication: () => window.close(),
        canExportResult: true,
        canResetView,
        resetView,
        exportResult: () => {
          // Export buttons still belong to the compatibility runtime. This
          // adapter is the only chrome-level place allowed to invoke them.
          const ids: Partial<Record<WorkspacePanelId, string>> = {
            h2r: "rt-export-btn",
            r2r: "r2r-export-btn",
            batch: "batch-result-download",
            "dataset-viz": "dv-export-json",
          };
          const button = document.getElementById(ids[props.activePanel] ?? "");
          if (button instanceof HTMLButtonElement && !button.disabled)
            button.click();
        },
      }),
    [
      canResetView,
      props.activePanel,
      props.locale,
      props.onOpenAbout,
      props.onOpenSettings,
      props.onToggleTheme,
      props.theme,
      resetView,
    ],
  );
}

const labels: Record<WorkspaceLocale, Record<DesktopMenuId, string>> = {
  en: {
    file: "File",
    workflows: "Workflows",
    analysis: "Analysis",
    settings: "Settings",
    help: "Help",
  },
  "zh-CN": {
    file: "文件",
    workflows: "工作流",
    analysis: "分析",
    settings: "设置",
    help: "帮助",
  },
};

/** Compact desktop menubar built from the same command registry as Ctrl+K. */
export function DesktopMenuBar(props: ApplicationChromeProps) {
  const commands = useApplicationCommands(props);
  const [openMenu, setOpenMenu] = useState<DesktopMenuId | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <nav
      ref={root}
      className="desktop-menubar"
      role="menubar"
      aria-label="Application menu"
    >
      {DESKTOP_MENUS.map((menu) => {
        const menuCommands = commands.filter(
          (command) => command.menu === menu.id,
        );
        return (
          <div key={menu.id} className="desktop-menu-root">
            <button
              type="button"
              className={cn(
                "desktop-menu-trigger",
                openMenu === menu.id && "active",
              )}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openMenu === menu.id}
              data-menu-trigger={menu.id}
              onClick={() =>
                setOpenMenu((current) => (current === menu.id ? null : menu.id))
              }
              onMouseEnter={() => {
                if (openMenu) setOpenMenu(menu.id);
              }}
            >
              {labels[props.locale][menu.id]}
            </button>
            {openMenu === menu.id && (
              <div
                className="desktop-menu-popup"
                role="menu"
                aria-label={labels[props.locale][menu.id]}
                data-menu-popup={menu.id}
              >
                {menuCommands.map((command) => (
                  <CommandMenuItem
                    key={command.id}
                    command={command}
                    onRun={() => setOpenMenu(null)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function CommandMenuItem({
  command,
  onRun,
}: {
  command: ApplicationCommand;
  onRun(): void;
}) {
  return (
    <div className={cn(command.dividerBefore && "desktop-menu-divider-group")}>
      {command.dividerBefore && (
        <div className="desktop-menu-separator" role="separator" />
      )}
      <button
        type="button"
        className="desktop-menu-item"
        role="menuitem"
        disabled={command.enabled === false}
        title={command.disabledReason || command.detail}
        onClick={() => {
          command.run();
          onRun();
        }}
      >
        <span className="desktop-menu-item-copy">
          <span>{command.label}</span>
        </span>
        {command.shortcut && <kbd>{command.shortcut}</kbd>}
        {!command.shortcut && command.disabledReason && (
          <small className="desktop-menu-disabled">
            {command.disabledReason}
          </small>
        )}
      </button>
    </div>
  );
}

/** VS Code-style command surface with one registry shared by menus and keys. */
export function CommandPalette(props: ApplicationChromeProps) {
  const commands = useApplicationCommands(props);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const text = (en: string, zh: string) => (props.locale === "zh-CN" ? zh : en);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? commands.filter((command) =>
          `${command.label} ${command.detail} ${command.keywords}`
            .toLowerCase()
            .includes(needle),
        )
      : commands;
  }, [commands, query]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
        setQuery("");
        setSelected(0);
        return;
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((current) => Math.min(filtered.length - 1, current + 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((current) => Math.max(0, current - 1));
      }
      if (event.key === "Enter" && filtered[selected]?.enabled !== false) {
        event.preventDefault();
        filtered[selected]?.run();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [filtered, open, selected]);
  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="command-palette-trigger"
        title={text("Open command palette", "打开命令面板")}
        onClick={() => {
          setOpen(true);
          setQuery("");
          setSelected(0);
        }}
      >
        <Search aria-hidden="true" />
        <span>{text("Commands", "命令")}</span>
        <kbd>Ctrl K</kbd>
      </button>
      {open && (
        <div
          className="command-palette-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label={text("Command palette", "命令面板")}
          >
            <div className="command-palette-search">
              <Search aria-hidden="true" />
              <input
                ref={input}
                type="search"
                value={query}
                placeholder={text(
                  "Search workspace, import, playback, or view commands",
                  "搜索工作区、导入、播放或视图命令",
                )}
                aria-label={text("Search commands", "搜索命令")}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setSelected(0);
                }}
              />
              <kbd>Esc</kbd>
            </div>
            <div className="command-palette-list" role="listbox">
              {filtered.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  className={cn(
                    "command-palette-item",
                    selected === index && "selected",
                    command.enabled === false && "disabled",
                  )}
                  role="option"
                  aria-selected={selected === index}
                  aria-disabled={command.enabled === false}
                  disabled={command.enabled === false}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => {
                    command.run();
                    setOpen(false);
                  }}
                >
                  <span className="command-palette-copy">
                    <strong>{command.label}</strong>
                    <small>
                      {command.group} · {command.detail}
                    </small>
                  </span>
                  {command.shortcut && <kbd>{command.shortcut}</kbd>}
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="command-palette-empty">
                  {text("No matching commands", "没有匹配的命令")}
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
