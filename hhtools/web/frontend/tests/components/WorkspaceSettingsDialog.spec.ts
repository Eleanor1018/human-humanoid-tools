import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import WorkspaceSettingsDialog from '../../src/components/WorkspaceSettingsDialog.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.querySelectorAll('.workspace-settings-backdrop').forEach((element) => element.remove())
})

describe('WorkspaceSettingsDialog', () => {
  it('emits panel visibility and reset commands', () => {
    const wrapper = mount(WorkspaceSettingsDialog, {
      props: { open: true, locale: 'en', sidebarHidden: false, inspectorHidden: false },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const toggles = document.body.querySelectorAll<HTMLInputElement>('.workspace-setting-row input')
    toggles[0].checked = false
    toggles[0].dispatchEvent(new Event('change', { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>('.workspace-settings-reset')?.click()

    expect(wrapper.emitted('setHidden')).toEqual([['sidebar', true]])
    expect(wrapper.emitted('reset')).toHaveLength(1)
  })

  it('emits the selected desktop language', () => {
    const wrapper = mount(WorkspaceSettingsDialog, {
      props: { open: true, locale: 'en', sidebarHidden: false, inspectorHidden: false },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const language = document.body.querySelector<HTMLSelectElement>('.workspace-language-select')
    if (!language) throw new Error('Language selector was not rendered')
    language.value = 'zh-CN'
    language.dispatchEvent(new Event('change', { bubbles: true }))

    expect(wrapper.emitted('setLocale')).toEqual([['zh-CN']])
  })
})
