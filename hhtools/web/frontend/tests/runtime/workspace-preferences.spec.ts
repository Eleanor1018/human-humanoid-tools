import { beforeEach, describe, expect, it } from 'vitest'

import {
  loadWorkspacePreferences,
  updateWorkspacePreferences,
} from '../../src/runtime/workspace-preferences'

const STORAGE_KEY = 'hhtools-workspace-preferences-v1'

beforeEach(() => localStorage.clear())

describe('workspace preferences', () => {
  it('persists the active workspace, playback state, and comparison presets', () => {
    updateWorkspacePreferences({
      activePanel: 'r2r',
      playbackSpeed: 1.5,
      playbackLoop: false,
      comparisonPresets: {
        h2r: 'target',
        r2r: 'result',
      },
    })

    expect(loadWorkspacePreferences()).toMatchObject({
      activePanel: 'r2r',
      playbackSpeed: 1.5,
      playbackLoop: false,
      comparisonPresets: {
        h2r: 'target',
        r2r: 'result',
      },
    })
  })

  it('falls back safely when stored values are unsupported', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      activePanel: 'unknown',
      locale: 'fr',
      theme: 'neon',
      playbackSpeed: 99,
      playbackLoop: 'yes',
      comparisonPresets: {
        h2r: 'invalid',
        r2r: 'source',
      },
    }))

    expect(loadWorkspacePreferences()).toEqual({
      activePanel: 'motion',
      locale: 'en',
      theme: 'light',
      playbackSpeed: 4,
      playbackLoop: true,
      comparisonPresets: {
        h2r: 'overlay',
        r2r: 'source',
      },
    })
  })

  it('migrates the retired video workspace to the unified workflow', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activePanel: 'video' }))

    expect(loadWorkspacePreferences().activePanel).toBe('video-to-motion')
  })
})
