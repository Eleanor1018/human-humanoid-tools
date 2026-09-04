export type ViewId =
  | "motion"
  | "robot-assets"
  | "video-to-motion"
  | "h2r"
  | "r2r"
  | "batch"
  | "dataset-viz";

interface NavigationItem {
  id: ViewId;
  label: string;
  icon: string;
}

interface NavigationGroup {
  label: string;
  items: readonly NavigationItem[];
}

export const navigationGroups: readonly NavigationGroup[] = [
  {
    label: "Assets",
    items: [
      { id: "motion", label: "Motion", icon: "/icons/sidebar/motion.svg" },
      {
        id: "robot-assets",
        label: "Robot",
        icon: "/icons/sidebar/robot.svg",
      },
    ],
  },
  {
    label: "Workflows",
    items: [
      {
        id: "video-to-motion",
        label: "Video → Motion",
        icon: "/icons/sidebar/video-to-motion.svg",
      },
      {
        id: "h2r",
        label: "Human → Robot",
        icon: "/icons/sidebar/h2r.svg",
      },
      {
        id: "r2r",
        label: "Robot → Robot",
        icon: "/icons/sidebar/r2r.svg",
      },
      { id: "batch", label: "Batch", icon: "/icons/sidebar/batch.svg" },
    ],
  },
  {
    label: "Analysis",
    items: [
      {
        id: "dataset-viz",
        label: "Data Analysis",
        icon: "/icons/sidebar/analysis.svg",
      },
    ],
  },
];
