import { describe, expect, it } from "vitest"

import { sortRobotLibrarySummaries } from "../../src/runtime/robot-library-order"

interface TestRobotSummary {
  name: string
  display_name: string
  builtin: boolean
  deletable: boolean
}

describe("sortRobotLibrarySummaries", () => {
  it("pins G1, RPO and X2 at the top and Berkeley at the bottom", () => {
    const input: TestRobotSummary[] = [
      { name: "berkeley_humanoid_lite", display_name: "Berkeley Humanoid Lite", builtin: true, deletable: false },
      { name: "fourier_gr2", display_name: "Fourier GR-2", builtin: true, deletable: false },
      { name: "agibot_x2_ultra", display_name: "AgiBot X2", builtin: true, deletable: false },
      { name: "asimov_1", display_name: "Asimov 1", builtin: true, deletable: false },
      { name: "roboto_origin", display_name: "ROBOTO_ORIGIN (RPO)", builtin: true, deletable: false },
      { name: "g1_29dof", display_name: "Unitree G1", builtin: true, deletable: false },
    ]

    const result = sortRobotLibrarySummaries(input, (robot) => robot.display_name)

    expect(result.map((robot) => robot.name)).toEqual([
      "g1_29dof",
      "roboto_origin",
      "agibot_x2_ultra",
      "asimov_1",
      "fourier_gr2",
      "berkeley_humanoid_lite",
    ])
    expect(result).not.toBe(input)
  })

  it("does not mutate built-in metadata when ordering RPO", () => {
    const rpo: TestRobotSummary = {
      name: "roboto_origin",
      display_name: "ROBOTO_ORIGIN (RPO)",
      builtin: true,
      deletable: false,
    }

    const [result] = sortRobotLibrarySummaries([rpo], (robot) => robot.display_name)

    expect(result).toEqual(rpo)
    expect(result.builtin).toBe(true)
    expect(result.deletable).toBe(false)
  })

  it("sorts object prototype keys as ordinary user robot IDs", () => {
    const input: TestRobotSummary[] = [
      { name: "constructor", display_name: "Zeta Custom", builtin: false, deletable: true },
      { name: "asimov_1", display_name: "Asimov 1", builtin: true, deletable: false },
    ]

    const result = sortRobotLibrarySummaries(input, (robot) => robot.display_name)

    expect(result.map((robot) => robot.name)).toEqual(["asimov_1", "constructor"])
    expect(result[1].deletable).toBe(true)
  })
})
