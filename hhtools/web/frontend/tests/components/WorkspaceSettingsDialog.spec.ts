import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import WorkspaceSettingsDialog from '../../src/components/WorkspaceSettingsDialog.vue'

const wrappers: Array<ReturnType<typeof mount>> = []
const defaultProps = {
  open: true,
  locale: 'en' as const,
  sidebarHidden: false,
  inspectorHidden: false,
  jobAdmission: {
    max_running_jobs: 0,
    max_queued_jobs: 0,
    running_jobs: 0,
    queued_jobs: 0,
    reserved_jobs: 0,
    editable: true,
  },
  jobAdmissionLoading: false,
  jobAdmissionSaving: false,
  jobAdmissionError: null,
  jobAdmissionErrorOperation: null,
  jobAdmissionSaved: false,
}

async function setTeleportedInput(
  wrapper: ReturnType<typeof mount>,
  selector: string,
  value: string,
): Promise<HTMLInputElement> {
  const input = document.body.querySelector<HTMLInputElement>(selector)
  if (!input) throw new Error(`Input was not rendered: ${selector}`)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wrapper.vm.$nextTick()
  return input
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.querySelectorAll('.workspace-settings-backdrop').forEach((element) => element.remove())
})

describe('WorkspaceSettingsDialog', () => {
  it('emits panel visibility and reset commands', () => {
    const wrapper = mount(WorkspaceSettingsDialog, {
      props: defaultProps,
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const toggles = document.body.querySelectorAll<HTMLInputElement>('.workspace-setting-row input[type="checkbox"]')
    toggles[0].checked = false
    toggles[0].dispatchEvent(new Event('change', { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>('.workspace-settings-reset')?.click()

    expect(wrapper.emitted('setHidden')).toEqual([['sidebar', true]])
    expect(wrapper.emitted('reset')).toHaveLength(1)
  })

  it('emits the selected desktop language', () => {
    const wrapper = mount(WorkspaceSettingsDialog, {
      props: defaultProps,
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const language = document.body.querySelector<HTMLSelectElement>('.workspace-language-select')
    if (!language) throw new Error('Language selector was not rendered')
    language.value = 'zh-CN'
    language.dispatchEvent(new Event('change', { bubbles: true }))

    expect(wrapper.emitted('setLocale')).toEqual([['zh-CN']])
  })

  it('keeps the queue editable in unlimited mode and emits validated integer limits', async () => {
    const wrapper = mount(WorkspaceSettingsDialog, {
      props: {
        ...defaultProps,
        jobAdmission: {
          ...defaultProps.jobAdmission,
          max_queued_jobs: 32,
          running_jobs: 1,
          reserved_jobs: 2,
        },
      },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const running = document.body.querySelector<HTMLInputElement>('.workspace-max-running-jobs')
    const queued = document.body.querySelector<HTMLInputElement>('.workspace-max-queued-jobs')
    const save = document.body.querySelector<HTMLButtonElement>('.workspace-settings-save')
    if (!running || !queued || !save) throw new Error('Job-admission controls were not rendered')

    expect(running.value).toBe('0')
    expect(queued.value).toBe('32')
    expect(queued.disabled).toBe(false)
    expect(document.body.querySelector('.workspace-settings-note')?.textContent).toContain('inactive')

    await setTeleportedInput(wrapper, '.workspace-max-running-jobs', '2')
    await setTeleportedInput(wrapper, '.workspace-max-queued-jobs', '16')
    save.click()

    expect(wrapper.emitted('saveJobAdmission')).toEqual([[
      { max_running_jobs: 2, max_queued_jobs: 16 },
    ]])
  })

  it('rejects invalid drafts and prevents duplicate saves while a request is pending', async () => {
    const wrapper = mount(WorkspaceSettingsDialog, {
      props: defaultProps,
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    await setTeleportedInput(wrapper, '.workspace-max-running-jobs', '-1')
    const save = document.body.querySelector<HTMLButtonElement>('.workspace-settings-save')
    if (!save) throw new Error('Save button was not rendered')
    expect(save.disabled).toBe(true)
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('greater than or equal to 0')

    await setTeleportedInput(wrapper, '.workspace-max-running-jobs', '2')
    await wrapper.setProps({ jobAdmissionSaving: true })
    expect(save.disabled).toBe(true)
    save.click()
    expect(wrapper.emitted('saveJobAdmission')).toBeUndefined()
  })

  it('retains draft values after an error and confirms that a successful save needs no restart', async () => {
    const wrapper = mount(WorkspaceSettingsDialog, {
      props: defaultProps,
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    await setTeleportedInput(wrapper, '.workspace-max-running-jobs', '4')
    await setTeleportedInput(wrapper, '.workspace-max-queued-jobs', '24')
    await wrapper.setProps({
      jobAdmissionError: 'Unable to save limits',
      jobAdmissionErrorOperation: 'save',
    })

    expect(document.body.querySelector<HTMLInputElement>('.workspace-max-running-jobs')?.value).toBe('4')
    expect(document.body.querySelector<HTMLInputElement>('.workspace-max-queued-jobs')?.value).toBe('24')
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Unable to save limits')
    expect(document.body.querySelector('.workspace-settings-retry')).toBeNull()

    // Retrying a failed save uses the same draft through the normal Save action.
    document.body.querySelector<HTMLButtonElement>('.workspace-settings-save')?.click()
    expect(wrapper.emitted('saveJobAdmission')?.at(-1)).toEqual([
      { max_running_jobs: 4, max_queued_jobs: 24 },
    ])

    await wrapper.setProps({
      locale: 'zh-CN',
      jobAdmissionError: null,
      jobAdmissionErrorOperation: null,
      jobAdmissionSaved: true,
      jobAdmission: {
        ...defaultProps.jobAdmission,
        max_running_jobs: 4,
        max_queued_jobs: 24,
      },
    })
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('无需重启')
  })

  it('offers a reload only when reading settings fails', async () => {
    const wrapper = mount(WorkspaceSettingsDialog, {
      props: {
        ...defaultProps,
        jobAdmission: null,
        jobAdmissionError: 'Unable to load limits',
        jobAdmissionErrorOperation: 'load',
      },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const retry = document.body.querySelector<HTMLButtonElement>('.workspace-settings-retry')
    expect(retry?.textContent).toBe('Reload')
    retry?.click()
    expect(wrapper.emitted('refreshJobAdmission')).toHaveLength(1)
  })

  it('shows remote clients as read-only instead of allowing a doomed save', async () => {
    const wrapper = mount(WorkspaceSettingsDialog, {
      props: {
        ...defaultProps,
        jobAdmission: {
          ...defaultProps.jobAdmission,
          editable: false,
        },
      },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const running = document.body.querySelector<HTMLInputElement>('.workspace-max-running-jobs')
    const save = document.body.querySelector<HTMLButtonElement>('.workspace-settings-save')
    expect(running?.disabled).toBe(true)
    expect(save?.disabled).toBe(true)
    expect(document.body.querySelector('.workspace-settings-note')?.textContent).toContain('read-only')
  })
})
