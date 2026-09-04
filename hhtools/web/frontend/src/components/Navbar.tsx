import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface MenuCommand {
  label: string;
  shortcut?: string;
  dividerBefore?: boolean;
}

type MenuId = "file" | "workflows" | "analysis" | "settings" | "help";

interface MenuDefinition {
  id: MenuId;
  label: string;
  commands: readonly MenuCommand[];
}

const menus: readonly MenuDefinition[] = [
  {
    id: "file",
    label: "File",
    commands: [
      { label: "Import Motion File" },
      { label: "Import Motion Folder" },
      { label: "Import Video", dividerBefore: true },
      { label: "Import Robot URDF", dividerBefore: true },
      { label: "Import Robot Mesh Folder" },
      { label: "Current Result…" },
      { label: "Exit", dividerBefore: true },
    ],
  },
  {
    id: "workflows",
    label: "Workflows",
    commands: [
      { label: "Video to Motion", shortcut: "Alt+7" },
      { label: "Human to Robot", shortcut: "Alt+3" },
      { label: "Robot to Robot", shortcut: "Alt+4" },
      { label: "Batch", shortcut: "Alt+5" },
    ],
  },
  {
    id: "analysis",
    label: "Analysis",
    commands: [{ label: "Data Analysis", shortcut: "Alt+6" }],
  },
  {
    id: "settings",
    label: "Settings",
    commands: [{ label: "Settings" }, { label: "Dark Mode" }],
  },
  {
    id: "help",
    label: "Help",
    commands: [
      { label: "Tutorial" },
      { label: "About hhtools", dividerBefore: true },
    ],
  },
];

export function Navbar() {
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };

    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <header
      id="topbar"
      className="col-span-full row-start-1 z-[200] flex items-center border-b border-border-subtle bg-surface py-0 pr-3 pl-[25px]"
    >
      <div
        className="flex basis-[201px] shrink-0 items-center gap-2 text-lg font-bold tracking-normal text-foreground"
        aria-label="HHTOOLS"
      >
        <img className="size-6 object-contain" src="/hhtools-robot.svg" alt="" />
        <span>HHTOOLS</span>
      </div>

      <nav
        ref={root}
        className="flex self-stretch items-stretch gap-2"
        aria-label="Application menu"
      >
        {menus.map((menu) => (
          <div key={menu.id} className="relative flex items-center">
            <button
              type="button"
              className={cn(
                "h-7 cursor-pointer whitespace-nowrap rounded-sm border-0 bg-transparent px-2.5 text-xs font-medium tracking-normal text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                openMenu === menu.id && "bg-accent text-accent-foreground",
              )}
              aria-haspopup="menu"
              aria-expanded={openMenu === menu.id}
              onMouseEnter={() => setOpenMenu(menu.id)}
              onFocus={() => setOpenMenu(menu.id)}
              onClick={() => setOpenMenu(menu.id)}
            >
              {menu.label}
            </button>
            {openMenu === menu.id && (
              <div
                className="absolute top-[calc(100%+3px)] left-0 z-[120] min-w-[286px] max-w-[340px] rounded-lg border border-border-subtle bg-surface p-[5px] shadow-[var(--shadow-menu)]"
                role="menu"
                aria-label={menu.label}
              >
                {menu.commands.map((command) => (
                  <div key={command.label}>
                    {command.dividerBefore && (
                      <div
                        className="mx-1.5 my-1 h-px bg-border-subtle"
                        role="separator"
                      />
                    )}
                    <button
                      type="button"
                      className="flex min-h-9 w-full cursor-pointer items-center justify-between gap-3 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                      role="menuitem"
                      onClick={() => setOpenMenu(null)}
                    >
                      <span className="grid min-w-0 gap-0.5">
                        <span className="truncate text-[13px] font-semibold">
                          {command.label}
                        </span>
                      </span>
                      {command.shortcut && (
                        <kbd className="shrink-0 font-sans text-[10px] text-muted-foreground opacity-70">
                          {command.shortcut}
                        </kbd>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="flex-1" />
    </header>
  );
}
