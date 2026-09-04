import { beforeEach, describe, expect, it } from 'vitest'

import {
  hasSeenFirstRunTutorial,
  markFirstRunTutorialSeen,
} from '../../src/runtime/tutorial'
import tutorialSource from '../../src/runtime/tutorial.ts?raw'

describe('first-run tutorial persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('starts unseen in a new renderer profile', () => {
    expect(hasSeenFirstRunTutorial()).toBe(false)
  })

  it('stays seen after the first automatic launch is recorded', () => {
    markFirstRunTutorialSeen()

    expect(hasSeenFirstRunTutorial()).toBe(true)
  })

  it('honors the legacy completion flag after an upgrade', () => {
    window.localStorage.setItem('hhtools.web.tutorial.v1.done', '1')

    expect(hasSeenFirstRunTutorial()).toBe(true)
  })

  it('does not take visibility ownership of the React Stage HUD', () => {
    expect(tutorialSource).not.toContain('revealViewHud')
    expect(tutorialSource).not.toContain('getElementById("view-hud")')
  })
})
