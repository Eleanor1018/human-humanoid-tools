import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import SidebarNavigation from '../../src/components/SidebarNavigation.vue'

const mountedWrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => {
  mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('SidebarNavigation', () => {
  it('groups workspaces and emits a typed panel request', async () => {
    const wrapper = mount(SidebarNavigation, {
      props: { activePanel: 'motion' },
    })
    mountedWrappers.push(wrapper)

    expect(wrapper.findAll('.nav-group-label')).toHaveLength(0)
    expect(wrapper.findAll('[role="group"]').map((item) => item.attributes('aria-label'))).toEqual([
      '资产 Assets',
      '工作流 Workflows',
      '分析 Analysis',
      '帮助 Help',
    ])
    expect(wrapper.get('[data-panel="motion"]').classes()).toContain('active')
    expect(wrapper.get('#basket-badge').text()).toBe('0')
    await wrapper.get('[data-panel="h2r"]').trigger('click')
    expect(wrapper.emitted('request')).toEqual([['h2r']])
  })

  it('adds full-workspace analysis destinations in application mode', () => {
    const wrapper = mount(SidebarNavigation, {
      props: { activePanel: 'motion', workspace: true, locale: 'en' },
    })
    mountedWrappers.push(wrapper)

    expect(wrapper.get('[data-panel="dataset-viz"]').text()).toContain('Manual Analysis')
    expect(wrapper.findAll('.nav-group-label')).toHaveLength(0)
    expect(wrapper.findAll('[role="group"]').map((item) => item.attributes('aria-label'))).toEqual([
      'Assets',
      'Workflows',
      'Analysis',
      'Help',
    ])
    const pae = wrapper.findAll<HTMLButtonElement>('.nav-item')
      .find((item) => item.text().includes('PAE Analysis'))
    const videoToMotion = wrapper.findAll<HTMLButtonElement>('.nav-item')
      .find((item) => item.text().includes('Video → Motion'))
    expect(pae?.attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-panel="video"]').text()).toContain('Video')
    expect(videoToMotion?.attributes('disabled')).toBeUndefined()
    expect(videoToMotion?.attributes('data-panel')).toBe('video-to-motion')
  })
})
