import { useEffect, useRef, useState } from "react";

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
    <header id="topbar">
      <div className="logo" aria-label="HHTOOLS">
        <img className="desktop-logo-mark" src="/hhtools-robot.svg" alt="" />
        <span className="desktop-brand-name">HHTOOLS</span>
      </div>

      <nav
        ref={root}
        className="desktop-menubar"
        aria-label="Application menu"
      >
        {menus.map((menu) => (
          <div key={menu.id} className="desktop-menu-root">
            <button
              type="button"
              className={`desktop-menu-trigger${openMenu === menu.id ? " active" : ""}`}
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
                className="desktop-menu-popup"
                role="menu"
                aria-label={menu.label}
              >
                {menu.commands.map((command) => (
                  <div
                    key={command.label}
                    className={
                      command.dividerBefore
                        ? "desktop-menu-divider-group"
                        : undefined
                    }
                  >
                    {command.dividerBefore && (
                      <div className="desktop-menu-separator" role="separator" />
                    )}
                    <button
                      type="button"
                      className="desktop-menu-item"
                      role="menuitem"
                      onClick={() => setOpenMenu(null)}
                    >
                      <span className="desktop-menu-item-copy">
                        <span>{command.label}</span>
                      </span>
                      {command.shortcut && <kbd>{command.shortcut}</kbd>}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="spacer" />
    </header>
  );
}
