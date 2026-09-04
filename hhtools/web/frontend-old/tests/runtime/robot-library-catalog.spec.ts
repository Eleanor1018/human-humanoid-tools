import { describe, expect, it } from "vitest"

import {
  CURATED_ROBOT_LIBRARY_ITEMS,
  curatedRobotLibraryItem,
  DEFAULT_ROBOT_LIBRARY_ICON,
  robotLibraryIcon,
} from "../../src/runtime/robot-library-catalog"

const CURATED_NAMES = [
  "g1_29dof",
  "roboto_origin",
  "agibot_x2_ultra",
  "asimov_1",
  "fourier_gr2",
  "berkeley_humanoid_lite",
]

describe("Robot Library catalog", () => {
  it("defines localized labels and a dedicated icon for every curated robot", () => {
    expect(Object.keys(CURATED_ROBOT_LIBRARY_ITEMS)).toEqual(CURATED_NAMES)

    for (const name of CURATED_NAMES) {
      const item = curatedRobotLibraryItem(name)
      expect(item?.en).toBeTruthy()
      expect(item?.zh).toBeTruthy()
      expect(item?.icon).toMatch(/^\.\/robot-icons\/.+\.webp$/)
    }
  })

  it("keeps the original generic icon for user-imported robots", () => {
    expect(curatedRobotLibraryItem("user_uploaded_robot")).toBeUndefined()
    expect(robotLibraryIcon("user_uploaded_robot")).toBe(DEFAULT_ROBOT_LIBRARY_ICON)
    expect(DEFAULT_ROBOT_LIBRARY_ICON).toBe("./hhtools-robot.svg")
  })

  it("does not treat object prototype keys as curated robot IDs", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(curatedRobotLibraryItem(name)).toBeUndefined()
      expect(robotLibraryIcon(name)).toBe(DEFAULT_ROBOT_LIBRARY_ICON)
    }
  })
})
