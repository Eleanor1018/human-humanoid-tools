/** The generic HHTools mark remains the fallback for user-imported robots. */
export const DEFAULT_ROBOT_LIBRARY_ICON = "./hhtools-robot.svg"

export interface CuratedRobotLibraryItem {
  en: string
  zh: string
  icon: string
}

/**
 * Product-curated robots shown as built-in in the local Robot Library.
 *
 * Keep this catalog limited to models deliberately supported by HHTools. A
 * robot uploaded by a user must not gain built-in status merely because its
 * display name resembles one of these entries.
 */
export const CURATED_ROBOT_LIBRARY_ITEMS: Readonly<Record<string, CuratedRobotLibraryItem>> = {
  g1_29dof: {
    en: "Unitree G1",
    zh: "宇树 G1",
    icon: "./robot-icons/unitree-g1.webp",
  },
  roboto_origin: {
    en: "ROBOTO_ORIGIN (RPO)",
    zh: "ROBOTO_ORIGIN (RPO)",
    icon: "./robot-icons/roboto-origin.webp",
  },
  agibot_x2_ultra: {
    en: "AgiBot X2",
    zh: "智元 X2",
    icon: "./robot-icons/agibot-x2.webp",
  },
  asimov_1: {
    en: "Asimov 1",
    zh: "Asimov 1",
    icon: "./robot-icons/asimov-1.webp",
  },
  fourier_gr2: {
    en: "Fourier GR-2",
    zh: "傅利叶 GR-2",
    icon: "./robot-icons/fourier-gr2.webp",
  },
  berkeley_humanoid_lite: {
    en: "Berkeley Humanoid Lite",
    zh: "伯克利 Humanoid Lite",
    icon: "./robot-icons/berkeley-humanoid-lite.webp",
  },
}

export function curatedRobotLibraryItem(name: string): CuratedRobotLibraryItem | undefined {
  return Object.prototype.hasOwnProperty.call(CURATED_ROBOT_LIBRARY_ITEMS, name)
    ? CURATED_ROBOT_LIBRARY_ITEMS[name]
    : undefined
}

export function robotLibraryIcon(name: string): string {
  return curatedRobotLibraryItem(name)?.icon ?? DEFAULT_ROBOT_LIBRARY_ICON
}
