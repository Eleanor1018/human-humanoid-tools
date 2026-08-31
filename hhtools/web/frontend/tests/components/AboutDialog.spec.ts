import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import AboutDialog from '../../src/components/AboutDialog.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.querySelectorAll('.about-dialog-backdrop').forEach((element) => element.remove())
})

describe('AboutDialog', () => {
  it('shows project attribution without version or build metadata', () => {
    const wrapper = mount(AboutDialog, {
      props: { open: true, locale: 'en' },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const content = document.body.textContent ?? ''
    expect(content).toContain('Human-Humanoid Tools')
    expect(content).toContain('Humanoid motion retargeting and dataset analysis')
    expect(content).toContain('jaggerShen and hhtools contributors')
    expect(content).toContain('Apache-2.0')
    expect(content).toContain('shenyaojie@roboparty.com')
    expect(content).toContain('sunlancheng@roboparty.com')
    expect(content).not.toContain('Version')
    expect(content).not.toContain('Build')
  })

  it('closes with Escape', async () => {
    const wrapper = mount(AboutDialog, {
      props: { open: true, locale: 'zh-CN' },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
