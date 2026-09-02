import type {
  WorkspaceLocale,
  WorkspacePanelId,
} from "@/workbench/common/workspace";
import { cn } from "@/lib/utils";

interface NavigationItem {
  id: WorkspacePanelId;
  enLabel: string;
  zhLabel: string;
  icon: string;
  badgeId?: string;
}

interface NavigationGroup {
  enLabel: string;
  zhLabel: string;
  items: NavigationItem[];
}

const groups: NavigationGroup[] = [
  {
    enLabel: "Assets",
    zhLabel: "资产",
    items: [
      { id: "motion", enLabel: "Motion", zhLabel: "动作", icon: "🎞" },
      { id: "robot-assets", enLabel: "Robot", zhLabel: "机器人", icon: "🤖" },
    ],
  },
  {
    enLabel: "Workflows",
    zhLabel: "工作流",
    items: [
      {
        id: "video-to-motion",
        enLabel: "Video → Motion",
        zhLabel: "视频 → 动作",
        icon: "🎥",
      },
      {
        id: "h2r",
        enLabel: "Human → Robot",
        zhLabel: "人体 → 机器人",
        icon: "↗",
      },
      {
        id: "r2r",
        enLabel: "Robot → Robot",
        zhLabel: "机器人 → 机器人",
        icon: "🔁",
      },
      {
        id: "batch",
        enLabel: "Batch",
        zhLabel: "批量处理",
        icon: "🧺",
        badgeId: "basket-badge",
      },
    ],
  },
  {
    enLabel: "Analysis",
    zhLabel: "分析",
    items: [
      {
        id: "dataset-viz",
        enLabel: "Data Analysis",
        zhLabel: "数据分析",
        icon: "📊",
      },
    ],
  },
];

interface SidebarNavigationProps {
  activePanel: WorkspacePanelId;
  locale: WorkspaceLocale;
  onRequest(panel: WorkspacePanelId): void;
}

export function SidebarNavigation({
  activePanel,
  locale,
  onRequest,
}: SidebarNavigationProps) {
  const label = (en: string, zh: string): string =>
    locale === "zh-CN" ? zh : en;
  return (
    <div className="nav-groups">
      {groups.map((group) => (
        <section
          key={group.enLabel}
          className="nav-group"
          role="group"
          aria-label={label(group.enLabel, group.zhLabel)}
        >
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn("nav-item", activePanel === item.id && "active")}
              data-panel={item.id}
              title={label(item.enLabel, item.zhLabel)}
              onClick={() => onRequest(item.id)}
            >
              <span className="icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="nav-item-label">
                {label(item.enLabel, item.zhLabel)}
              </span>
              {item.badgeId && (
                <span
                  id={item.badgeId}
                  className="badge"
                  style={{ display: "none" }}
                >
                  0
                </span>
              )}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
