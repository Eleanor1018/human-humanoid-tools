import type { CSSProperties } from "react";

import { navigationGroups, type ViewId } from "../navigation";

interface SidebarProps {
  activeView: ViewId;
  onSelect(view: ViewId): void;
}

type IconStyle = CSSProperties & { "--sidebar-icon": string };

export function Sidebar({ activeView, onSelect }: SidebarProps) {
  return (
    <aside id="sidebar" aria-label="Workspace navigation">
      <nav className="sidebar-body">
        <div className="nav-groups">
          {navigationGroups.map((group) => (
            <section
              key={group.label}
              className="nav-group"
              aria-label={group.label}
            >
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item${activeView === item.id ? " active" : ""}`}
                  aria-current={activeView === item.id ? "page" : undefined}
                  onClick={() => onSelect(item.id)}
                >
                  <span
                    className="sidebar-icon"
                    style={
                      {
                        "--sidebar-icon": `url(${item.icon})`,
                      } as IconStyle
                    }
                    aria-hidden="true"
                  />
                  <span className="nav-item-label">{item.label}</span>
                </button>
              ))}
            </section>
          ))}
        </div>
      </nav>
    </aside>
  );
}
