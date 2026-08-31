/** Minimal robot summary shape needed by the Robot Library sorter. */
interface NamedRobotSummary {
  name: string
}

/**
 * Product-level placement in the Robot Library.
 *
 * This is deliberately separate from the built-in/deletable classification:
 * placing an imported robot near the top must not silently turn it into a
 * bundled model or hide its delete action.
 */
const PINNED_FIRST_ORDER: Readonly<Record<string, number>> = {
  g1_29dof: 0,
  roboto_origin: 1,
  agibot_x2_ultra: 2,
}

/** Models requested at the end of the Library, independent of UI language. */
const PINNED_LAST = new Set(["berkeley_humanoid_lite"])

function pinnedFirstOrder(name: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(PINNED_FIRST_ORDER, name)
    ? PINNED_FIRST_ORDER[name]
    : undefined
}

export function sortRobotLibrarySummaries<T extends NamedRobotSummary>(
  summaries: readonly T[],
  labelFor: (summary: T) => string,
): T[] {
  return [...summaries].sort((left, right) => {
    const leftPinned = pinnedFirstOrder(left.name)
    const rightPinned = pinnedFirstOrder(right.name)

    if (leftPinned != null || rightPinned != null) {
      if (leftPinned == null) return 1
      if (rightPinned == null) return -1
      return leftPinned - rightPinned
    }

    const leftLast = PINNED_LAST.has(left.name)
    const rightLast = PINNED_LAST.has(right.name)
    if (leftLast !== rightLast) return leftLast ? 1 : -1

    return labelFor(left).localeCompare(labelFor(right))
  })
}
