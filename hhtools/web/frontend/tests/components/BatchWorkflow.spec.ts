import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import BatchWorkflow from '../../src/components/BatchWorkflow.vue'
import type { HhAppBridge } from '../../src/runtime/types'

const wrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  delete window.__hhApp
  document.body.innerHTML = ''
})

function mountWorkflow(props: { active: boolean; locale?: 'en' | 'zh-CN' }) {
  const stage = document.createElement('main')
  stage.id = 'stage'
  document.body.append(stage)

  const wrapper = mount(BatchWorkflow, {
    props,
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return { stage, wrapper }
}

function installBridge(): ReturnType<typeof vi.fn> {
  const get = vi.fn(async () => ({ entries: [] }))
  window.__hhApp = {
    API: { get },
    addToBasket: vi.fn(),
  } as unknown as HhAppBridge
  return get
}

describe('BatchWorkflow', () => {
  it('teleports the active workspace into the stage and keeps every runtime DOM id unique', () => {
    const { stage } = mountWorkflow({ active: true, locale: 'en' })

    const workspace = stage.querySelector<HTMLElement>('.batch-stage-workspace')
    expect(workspace).not.toBeNull()
    expect(workspace?.style.display).not.toBe('none')
    expect(workspace?.textContent).toContain('Batch inputs')
    expect(workspace?.textContent).toContain('Add from Library')

    const runtimeIds = [
      'basket-count',
      'batch-library-open',
      'batch-pick-file',
      'batch-pick-folder',
      'batch-basket-search',
      'batch-basket-filter',
      'basket-drop',
      'basket-list',
      'batch-select-all',
      'batch-selected-count',
      'batch-remove-selected',
      'basket-clear',
      'batch-inspector-count',
      'batch-robot-select',
      'batch-robot-load',
      'batch-robot',
      'batch-ref-hint',
      'batch-backend',
      'batch-format',
      'batch-run',
      'batch-status',
      'batch-result-card',
      'batch-failures',
    ]
    runtimeIds.forEach((id) => {
      expect(document.querySelectorAll(`#${id}`), `${id} should appear exactly once`).toHaveLength(1)
    })
  })

  it('updates the central workspace and inspector copy when the locale changes', async () => {
    const { stage, wrapper } = mountWorkflow({ active: true, locale: 'en' })

    expect(stage.textContent).toContain('Build and validate the clip set before submitting a task.')
    expect(wrapper.text()).toContain('Human motions → one target robot')
    expect(wrapper.text()).toContain('Target robot & compatibility')
    expect(wrapper.text()).toContain('Start batch task')

    await wrapper.setProps({ locale: 'zh-CN' })

    expect(stage.textContent).toContain('先整理并检查动作清单，再提交批量任务。')
    expect(stage.textContent).toContain('从资源库添加')
    expect(wrapper.text()).toContain('人体动作 → 单个目标机器人')
    expect(wrapper.text()).toContain('目标机器人与兼容性')
    expect(wrapper.text()).toContain('开始批量任务')
  })

  it('opens the Motion Picker and routes robot imports through request-panel', async () => {
    const get = installBridge()
    const { stage, wrapper } = mountWorkflow({ active: true, locale: 'en' })

    const libraryButton = Array.from(stage.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Add from Library'))
    expect(libraryButton).toBeDefined()
    libraryButton?.click()
    await flushPromises()

    const dialog = document.body.querySelector<HTMLElement>('.motion-picker-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.textContent).toContain('Add motions')
    expect(get).toHaveBeenCalledWith('/api/library')

    const importRobotButton = wrapper.findAll('button')
      .find((button) => button.text().includes('Import robot'))
    expect(importRobotButton).toBeDefined()
    await importRobotButton?.trigger('click')
    expect(wrapper.emitted('request-panel')).toEqual([['robot-assets']])
  })

  it('hides the teleported workspace and closes its picker while inactive', async () => {
    installBridge()
    const { stage, wrapper } = mountWorkflow({ active: true, locale: 'en' })

    const libraryButton = Array.from(stage.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Add from Library'))
    libraryButton?.click()
    await flushPromises()
    expect(document.body.querySelector('.motion-picker-dialog')).not.toBeNull()

    await wrapper.setProps({ active: false })
    await flushPromises()

    const workspace = stage.querySelector<HTMLElement>('.batch-stage-workspace')
    expect(workspace).not.toBeNull()
    expect(workspace?.style.display).toBe('none')
    expect(document.body.querySelector('.motion-picker-dialog')).toBeNull()
  })
})
