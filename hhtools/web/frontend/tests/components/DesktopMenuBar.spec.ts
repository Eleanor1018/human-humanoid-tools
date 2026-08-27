import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import DesktopMenuBar from '../../src/components/DesktopMenuBar.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('DesktopMenuBar', () => {
  it('groups desktop commands and dispatches workflow navigation', async () => {
    const wrapper = mount(DesktopMenuBar, {
      props: { activePanel: 'motion' },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    expect(wrapper.findAll('.desktop-menu-trigger').map((item) => item.text())).toEqual([
      'File',
      'Workflows',
      'Analysis',
      'Settings',
      'Help',
    ])

    const panels: string[] = []
    const receive = (event: WindowEventMap['hhtools:panel-request']): void => {
      panels.push(event.detail)
    }
    window.addEventListener('hhtools:panel-request', receive)
    await wrapper.get('[data-menu-trigger="workflows"]').trigger('click')
    const h2r = wrapper.findAll('.desktop-menu-item').find((item) => item.text().includes('H2R'))
    await h2r?.trigger('click')
    window.removeEventListener('hhtools:panel-request', receive)

    expect(panels).toEqual(['h2r'])
  })

  it('shows unavailable analysis commands as disabled', async () => {
    const wrapper = mount(DesktopMenuBar, { props: { activePanel: 'motion' } })
    wrappers.push(wrapper)

    await wrapper.get('[data-menu-trigger="analysis"]').trigger('click')
    const pae = wrapper.findAll<HTMLButtonElement>('.desktop-menu-item')
      .find((item) => item.text().includes('PAE Analysis'))

    expect(pae?.attributes('disabled')).toBeDefined()
    expect(pae?.text()).toContain('Coming soon')
  })

  it('routes File imports and keeps workspace and theme settings in their own menu', async () => {
    const wrapper = mount(DesktopMenuBar, {
      props: { activePanel: 'motion', theme: 'light' },
    })
    wrappers.push(wrapper)
    const imports: string[] = []
    const receive = (event: WindowEventMap['hhtools:import-command']): void => {
      imports.push(event.detail.target)
    }
    window.addEventListener('hhtools:import-command', receive)

    await wrapper.get('[data-menu-trigger="file"]').trigger('click')
    const items = wrapper.findAll('.desktop-menu-item')
    expect(items.some((item) => item.text().includes('Settings'))).toBe(false)
    const motionFile = items.find((item) => item.text().includes('Import Motion File'))
    await motionFile?.trigger('click')
    window.removeEventListener('hhtools:import-command', receive)

    expect(imports).toEqual(['motion-file'])

    await wrapper.get('[data-menu-trigger="settings"]').trigger('click')
    const settingsItems = wrapper.findAll('.desktop-menu-item')
    expect(settingsItems.map((item) => item.text())).toEqual([
      expect.stringContaining('Settings'),
      expect.stringContaining('Dark Mode'),
    ])
    await settingsItems[0]?.trigger('click')
    expect(wrapper.emitted('openSettings')).toHaveLength(1)

    await wrapper.get('[data-menu-trigger="settings"]').trigger('click')
    const darkMode = wrapper.findAll('.desktop-menu-item')
      .find((item) => item.text().includes('Dark Mode'))
    await darkMode?.trigger('click')
    expect(wrapper.emitted('toggleTheme')).toHaveLength(1)
  })
})
