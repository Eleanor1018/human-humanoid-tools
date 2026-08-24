import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import type { PlaybackCommandDetail, PlaybackUiState } from '../runtime/types'
import PlaybackBar from './PlaybackBar.vue'

const mountedWrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => {
  mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('PlaybackBar', () => {
  it('renders typed runtime state and emits typed playback commands', async () => {
    const wrapper = mount(PlaybackBar)
    mountedWrappers.push(wrapper)

    const state: PlaybackUiState = {
      visible: true,
      active: true,
      playing: false,
      loop: true,
      progress: 0.25,
      speed: 1.5,
      label: '1.00 / 4.00 s',
    }
    window.dispatchEvent(
      new CustomEvent<Partial<PlaybackUiState>>('hhtools:playback-state', { detail: state }),
    )
    await nextTick()

    expect(wrapper.get('#playbar').attributes('style')).not.toContain('display: none')
    expect(wrapper.get('#time-label').text()).toBe(state.label)
    expect(wrapper.get('#speed-label').text()).toBe('1.5×')

    const commands: PlaybackCommandDetail[] = []
    const receiveCommand = (event: WindowEventMap['hhtools:playback-command']): void => {
      commands.push(event.detail)
    }
    window.addEventListener('hhtools:playback-command', receiveCommand)

    await wrapper.get('#play-btn').trigger('click')
    await wrapper.get('#scrubber').setValue('50')
    await wrapper.get('#loop-btn').trigger('click')

    window.removeEventListener('hhtools:playback-command', receiveCommand)
    expect(commands).toEqual([
      { action: 'toggle', value: undefined },
      { action: 'seek', value: 0.5 },
      { action: 'loop', value: undefined },
    ])
  })
})
