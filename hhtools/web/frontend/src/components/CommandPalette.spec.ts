import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import CommandPalette from './CommandPalette.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

beforeEach(() => localStorage.clear())
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.querySelectorAll('.command-palette-scrim').forEach((element) => element.remove())
})

describe('CommandPalette', () => {
  it('opens with Ctrl+K and dispatches a filtered command', async () => {
    const wrapper = mount(CommandPalette, {
      props: { activePanel: 'h2r' },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await nextTick()
    const input = document.body.querySelector<HTMLInputElement>('.command-palette-search input')
    expect(input).not.toBeNull()
    if (!input) return
    input.value = '机器人结果'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const requests: string[] = []
    const receive = (event: WindowEventMap['hhtools:comparison-command']): void => {
      requests.push(`${event.detail.workflow}:${event.detail.preset}`)
    }
    window.addEventListener('hhtools:comparison-command', receive)
    document.body.querySelector<HTMLButtonElement>('.command-palette-item')?.click()
    window.removeEventListener('hhtools:comparison-command', receive)

    expect(requests).toEqual(['h2r:result'])
  })

  it('supports workspace keyboard shortcuts outside editable controls', () => {
    const wrapper = mount(CommandPalette, { props: { activePanel: 'motion' } })
    wrappers.push(wrapper)
    const requests: string[] = []
    const receive = (event: WindowEventMap['hhtools:panel-request']): void => {
      requests.push(event.detail)
    }
    window.addEventListener('hhtools:panel-request', receive)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', altKey: true }))
    window.removeEventListener('hhtools:panel-request', receive)

    expect(requests).toEqual(['h2r'])
  })
})
