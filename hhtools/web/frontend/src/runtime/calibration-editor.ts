import type {
  CalibrationAngleUnit,
  CalibrationJointRegion,
} from './types'

const LEFT_TOKEN = /(^|[_\-.])(left|l)(?=[_\-.]|$)/
const RIGHT_TOKEN = /(^|[_\-.])(right|r)(?=[_\-.]|$)/

function normalizedJointName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_')
}

function hasAny(name: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => name.includes(token))
}

/** Classify common URDF joint names without assuming one vendor naming scheme. */
export function classifyCalibrationJoint(name: string): CalibrationJointRegion {
  const normalized = normalizedJointName(name)
  const left = normalized.startsWith('left') || LEFT_TOKEN.test(normalized)
  const right = normalized.startsWith('right') || RIGHT_TOKEN.test(normalized)

  if (hasAny(normalized, ['finger', 'thumb', 'hand', 'gripper'])) return 'hands'
  if (hasAny(normalized, ['head', 'neck', 'antenna'])) return 'head'

  const arm = hasAny(normalized, ['shoulder', 'elbow', 'wrist', 'arm'])
  if (arm && left) return 'left-arm'
  if (arm && right) return 'right-arm'

  const leg = hasAny(normalized, ['hip', 'knee', 'ankle', 'leg', 'foot', 'toe'])
  if (leg && left) return 'left-leg'
  if (leg && right) return 'right-leg'

  if (hasAny(normalized, ['pelvis', 'waist', 'torso', 'spine', 'chest', 'trunk', 'root'])) {
    return 'torso'
  }
  return 'other'
}

export function calibrationJointMatches(
  name: string,
  query: string,
  region: CalibrationJointRegion | 'all',
): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  const queryMatches = !normalizedQuery || name.toLowerCase().includes(normalizedQuery)
  return queryMatches && (region === 'all' || classifyCalibrationJoint(name) === region)
}

export function angleForDisplay(valueRad: number, unit: CalibrationAngleUnit): number {
  return unit === 'deg' ? valueRad * 180 / Math.PI : valueRad
}

export function angleFromDisplay(value: number, unit: CalibrationAngleUnit): number {
  return unit === 'deg' ? value * Math.PI / 180 : value
}

export function formatCalibrationAngle(
  valueRad: number,
  unit: CalibrationAngleUnit,
  precision = 3,
): string {
  return angleForDisplay(valueRad, unit).toFixed(unit === 'deg' ? Math.max(1, precision - 1) : precision)
}
