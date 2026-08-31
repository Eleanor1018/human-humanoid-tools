import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WorkspaceDrawerHandle from '../../src/components/WorkspaceDrawerHandle.vue'

describe('WorkspaceDrawerHandle', () => {
  it('points the left handle toward the drawer state and emits toggle', async () => {
    const wrapper = mount(WorkspaceDrawerHandle, {
      props: { side: 'left', expanded: true, locale: 'en' },
    })

    expect(wrapper.get('svg').attributes('data-icon')).toBe('chevron-left')
    expect(wrapper.attributes('aria-controls')).toBe('sidebar')
    expect(wrapper.attributes('aria-expanded')).toBe('true')
    expect(wrapper.attributes('aria-label')).toBe('Collapse left navigation')

    await wrapper.trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
    await wrapper.setProps({ expanded: false, locale: 'zh-CN' })
    expect(wrapper.get('svg').attributes('data-icon')).toBe('chevron-right')
    expect(wrapper.attributes('aria-label')).toBe('展开左侧导航')
  })

  it('mirrors the direction for the right drawer', async () => {
    const wrapper = mount(WorkspaceDrawerHandle, {
      props: { side: 'right', expanded: true, locale: 'en' },
    })

    expect(wrapper.get('svg').attributes('data-icon')).toBe('chevron-right')
    expect(wrapper.attributes('aria-controls')).toBe('inspector')
    await wrapper.setProps({ expanded: false })
    expect(wrapper.get('svg').attributes('data-icon')).toBe('chevron-left')
    expect(wrapper.attributes('aria-label')).toBe('Expand right inspector')
  })
})
