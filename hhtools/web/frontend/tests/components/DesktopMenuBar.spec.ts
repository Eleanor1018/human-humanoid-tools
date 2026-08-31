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
    const h2r = wrapper.findAll('.desktop-menu-item').find((item) => item.text().includes('Human to Robot'))
    await h2r?.trigger('click')
    window.removeEventListener('hhtools:panel-request', receive)

    expect(panels).toEqual(['h2r'])
  })

  it('routes the consolidated data-analysis command', async () => {
    const wrapper = mount(DesktopMenuBar, { props: { activePanel: 'motion' } })
    wrappers.push(wrapper)

    const panels: string[] = []
    const receive = (event: WindowEventMap['hhtools:panel-request']): void => {
      panels.push(event.detail)
    }
    window.addEventListener('hhtools:panel-request', receive)

    await wrapper.get('[data-menu-trigger="analysis"]').trigger('click')
    const analysis = wrapper.findAll<HTMLButtonElement>('.desktop-menu-item')
      .find((item) => item.text().includes('Data Analysis'))
    await analysis?.trigger('click')
    window.removeEventListener('hhtools:panel-request', receive)

    expect(analysis?.attributes('disabled')).toBeUndefined()
    expect(panels).toEqual(['dataset-viz'])
  })

  it('routes the enabled video-to-motion workflow', async () => {
    const wrapper = mount(DesktopMenuBar, { props: { activePanel: 'motion' } })
    wrappers.push(wrapper)

    const panels: string[] = []
    const receive = (event: WindowEventMap['hhtools:panel-request']): void => {
      panels.push(event.detail)
    }
    window.addEventListener('hhtools:panel-request', receive)

    await wrapper.get('[data-menu-trigger="workflows"]').trigger('click')
    const videoToMotion = wrapper.findAll<HTMLButtonElement>('.desktop-menu-item')
      .find((item) => item.text().includes('Video to Motion'))
    await videoToMotion?.trigger('click')
    window.removeEventListener('hhtools:panel-request', receive)

    expect(videoToMotion?.attributes('disabled')).toBeUndefined()
    expect(panels).toEqual(['video-to-motion'])
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
    const fileMenu = wrapper.get('[data-menu-popup="file"]')
    const rootItems = fileMenu.findAll('[data-menu-level="root"]')
    expect(rootItems.map((item) => item.text())).toEqual([
      expect.stringContaining('Import'),
      expect.stringContaining('Export'),
      expect.stringContaining('Exit'),
    ])
    expect(rootItems.some((item) => item.text().includes('Settings'))).toBe(false)
    expect(fileMenu.element.firstElementChild?.classList.contains('desktop-menu-separator')).toBe(false)
    expect(fileMenu.findAll('.desktop-menu-item-copy small')).toHaveLength(0)

    const importTrigger = fileMenu.get('[data-submenu-trigger="file-import"]')
    await importTrigger.trigger('mouseenter')
    await importTrigger.trigger('click')
    const importMenu = fileMenu.get('[data-submenu-popup="file-import"]')
    const importItems = importMenu.findAll('.desktop-menu-item')
    expect(importItems.some((item) => item.text().includes('Import Video'))).toBe(true)
    const motionFile = importItems.find((item) => item.text().includes('Import Motion File'))
    expect(motionFile?.attributes('title')).toContain('BVH, GLB, NPZ')
    await motionFile?.trigger('click')
    window.removeEventListener('hhtools:import-command', receive)

    expect(imports).toEqual(['motion-file'])

    await wrapper.get('[data-menu-trigger="file"]').trigger('click')
    await wrapper.get('[data-submenu-trigger="file-export"]').trigger('click')
    const exportResult = wrapper.get('[data-submenu-popup="file-export"] .desktop-menu-item')
    expect(exportResult.attributes('disabled')).toBeDefined()
    expect(exportResult.attributes('title')).toBe('No exportable result')

    await wrapper.get('[data-menu-trigger="settings"]').trigger('click')
    const settingsItems = wrapper.findAll('.desktop-menu-item')
    expect(settingsItems.map((item) => item.text())).toEqual([
      expect.stringContaining('Settings'),
      expect.stringContaining('Dark Mode'),
    ])
    expect(settingsItems[0]?.text()).toBe('Settings')
    expect(settingsItems[0]?.attributes('title')).toContain('background jobs')
    await settingsItems[0]?.trigger('click')
    expect(wrapper.emitted('openSettings')).toHaveLength(1)

    await wrapper.get('[data-menu-trigger="settings"]').trigger('click')
    const darkMode = wrapper.findAll('.desktop-menu-item')
      .find((item) => item.text().includes('Dark Mode'))
    await darkMode?.trigger('click')
    expect(wrapper.emitted('toggleTheme')).toHaveLength(1)
  })

  it('reuses the active workflow export control when a result is available', async () => {
    const result = document.createElement('div')
    const download = document.createElement('button')
    result.id = 'rt-export-card'
    download.id = 'rt-export-btn'
    result.append(download)
    document.body.append(result)
    let downloadCount = 0
    download.addEventListener('click', () => { downloadCount += 1 })

    const wrapper = mount(DesktopMenuBar, {
      props: { activePanel: 'h2r' },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    await wrapper.get('[data-menu-trigger="file"]').trigger('click')
    await wrapper.get('[data-submenu-trigger="file-export"]').trigger('click')
    const exportResult = wrapper.get('[data-submenu-popup="file-export"] .desktop-menu-item')
    expect(exportResult.attributes('disabled')).toBeUndefined()
    await exportResult.trigger('click')

    expect(downloadCount).toBe(1)
    result.remove()
  })
})
