import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import { navigationGroups, type ViewId } from "../navigation";

interface SidebarProps {
  activeView: ViewId;
  onSelect(view: ViewId): void;
}

type IconStyle = CSSProperties & { "--sidebar-icon": string };

export function Sidebar({ activeView, onSelect }: SidebarProps) {
  return (
    <aside
      id="sidebar"
      className="col-start-1 row-start-2 min-h-0 min-w-0 overflow-hidden border-r border-border-subtle bg-surface max-[780px]:row-span-2"
      aria-label="Workspace navigation"
    >
      <nav className="h-full min-h-0 min-w-0 overflow-y-auto px-3 py-3.5 max-[900px]:px-2">
        <div className="flex flex-col gap-3.5">
          {navigationGroups.map((group) => (
            <section
              key={group.label}
              className="flex flex-col gap-[3px]"
              aria-label={group.label}
            >
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-[13px] py-2.5 text-left text-sm font-medium tracking-normal text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring max-[900px]:justify-center max-[900px]:gap-0 max-[900px]:px-0",
                    activeView === item.id &&
                      "bg-accent text-accent-foreground",
                  )}
                  aria-current={activeView === item.id ? "page" : undefined}
                  title={item.label}
                  onClick={() => onSelect(item.id)}
                >
                  <span
                    className="sidebar-icon size-5 shrink-0 bg-current [mask:var(--sidebar-icon)_center/18px_18px_no-repeat] [-webkit-mask:var(--sidebar-icon)_center/18px_18px_no-repeat]"
                    style={
                      {
                        "--sidebar-icon": `url(${item.icon})`,
                      } as IconStyle
                    }
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate max-[900px]:sr-only">
                    {item.label}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      </nav>
    </aside>
  );
}
