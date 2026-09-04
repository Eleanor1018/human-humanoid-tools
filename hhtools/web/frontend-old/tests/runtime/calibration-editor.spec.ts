import { describe, expect, it } from 'vitest'

import {
  angleForDisplay,
  angleFromDisplay,
  calibrationJointMatches,
  classifyCalibrationJoint,
  formatCalibrationAngle,
} from '../../src/runtime/calibration-editor'

describe('calibration editor helpers', () => {
  it.each([
    ['left_shoulder_pitch_joint', 'left-arm'],
    ['R_Elbow_Joint', 'right-arm'],
    ['left_ankle_roll', 'left-leg'],
    ['r-knee', 'right-leg'],
    ['waist_yaw_joint', 'torso'],
    ['neck_pitch', 'head'],
    ['left_thumb_joint', 'hands'],
    ['accessory_joint', 'other'],
  ] as const)('classifies %s as %s', (name, region) => {
    expect(classifyCalibrationJoint(name)).toBe(region)
  })

  it('combines text search and body-region filters', () => {
    expect(calibrationJointMatches('left_shoulder_pitch', 'shoulder', 'left-arm')).toBe(true)
    expect(calibrationJointMatches('right_shoulder_pitch', 'shoulder', 'left-arm')).toBe(false)
    expect(calibrationJointMatches('left_knee_pitch', 'shoulder', 'all')).toBe(false)
  })

  it('converts display units without changing the stored radian value', () => {
    expect(angleForDisplay(Math.PI / 2, 'deg')).toBeCloseTo(90)
    expect(angleFromDisplay(90, 'deg')).toBeCloseTo(Math.PI / 2)
    expect(angleForDisplay(0.5, 'rad')).toBe(0.5)
    expect(formatCalibrationAngle(Math.PI / 2, 'deg')).toBe('90.00')
  })
})
