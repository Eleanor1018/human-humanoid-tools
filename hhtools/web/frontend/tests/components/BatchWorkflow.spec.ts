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

function installBridge() {
  const video = new File(['video'], 'walk.mp4', { type: 'video/mp4', lastModified: 1 })
  const entry = {
    source_path: 'generated/walk.pt',
    name: 'walk',
    asset_kind: 'human_motion' as const,
  }
  const get = vi.fn(async (url: string) => (
    url === '/api/video-to-motion/status'
      ? {
          ready: true,
          missing: [],
          checks: { docker_engine: true, runtime_image: true },
          root: 'C:/GVHMR',
          body_models_root: 'C:/GVHMR/inputs/checkpoints/body_models',
          image: 'hhtools-gvhmr:cu128',
          uses_official_weights: true,
          supports_custom_weights: true,
          training_enabled: false,
        }
      : { entries: [] }
  ))
  const addToBasket = vi.fn()
  const pickFiles = vi.fn(async () => [video])
  const uploadFilesXHR = vi.fn(async () => ({ job_id: 'job-v2m' }))
  const waitMotionJob = vi.fn(async () => ({
    name: 'walk',
    token: 'motion-token',
    positions: [],
    parent_indices: [],
    library_entry: entry,
  }))
  const refreshLibrary = vi.fn(async () => undefined)
  window.__hhApp = {
    API: { get },
    addToBasket,
    pickFiles,
    collectDroppedFiles: vi.fn(async () => []),
    uploadFilesXHR,
    waitMotionJob,
    refreshLibrary,
    toast: vi.fn(),
  } as unknown as HhAppBridge
  return { addToBasket, entry, get, pickFiles, refreshLibrary, uploadFilesXHR, waitMotionJob }
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
      'r2r-basket-count',
      'r2r-batch-pick-file',
      'r2r-batch-pick-folder',
      'r2r-basket-drop',
      'r2r-basket-list',
      'r2r-basket-clear',
      'r2r-batch-source-select',
      'r2r-batch-source-load',
      'r2r-batch-target-select',
      'r2r-batch-target-load',
      'r2r-batch-backend',
      'r2r-batch-format',
      'r2r-batch-run',
      'r2r-batch-status',
    ]
    runtimeIds.forEach((id) => {
      expect(document.querySelectorAll(`#${id}`), `${id} should appear exactly once`).toHaveLength(1)
    })
  })

  it('updates the central workspace and inspector copy when the locale changes', async () => {
    const { stage, wrapper } = mountWorkflow({ active: true, locale: 'en' })

    expect(stage.textContent).toContain('Build and validate the clip set before submitting a task.')
    expect(wrapper.text()).not.toContain('Human motions → one target robot')
    expect(wrapper.text()).toContain('H2R')
    expect(wrapper.text()).toContain('R2R')
    expect(wrapper.text()).toContain('V2M')
    expect(wrapper.text()).toContain('Target robot & compatibility')
    expect(wrapper.text()).toContain('Start batch task')

    await wrapper.setProps({ locale: 'zh-CN' })

    expect(stage.textContent).toContain('先整理并检查动作清单，再提交批量任务。')
    expect(stage.textContent).toContain('从资源库添加')
    expect(wrapper.text()).not.toContain('人体动作 → 单个目标机器人')
    expect(wrapper.text()).toContain('目标机器人与兼容性')
    expect(wrapper.text()).toContain('开始批量任务')
  })

  it('switches between independent H2R and R2R batch workspaces', async () => {
    installBridge()
    const { stage, wrapper } = mountWorkflow({ active: true, locale: 'zh-CN' })

    const h2rStage = stage.querySelector<HTMLElement>('.batch-stage-workspace:not(.r2r-batch-stage-workspace)')
    const r2rStage = stage.querySelector<HTMLElement>('.r2r-batch-stage-workspace')
    const v2mStage = stage.querySelector<HTMLElement>('.v2m-batch-stage-workspace')
    expect(h2rStage?.style.display).not.toBe('none')
    expect(r2rStage?.style.display).toBe('none')
    expect(v2mStage?.style.display).toBe('none')

    await wrapper.get('input[name="batch-workflow-mode"][value="v2m"]').setValue()
    await flushPromises()

    expect(h2rStage?.style.display).toBe('none')
    expect(r2rStage?.style.display).toBe('none')
    expect(v2mStage?.style.display).not.toBe('none')
    expect(v2mStage?.textContent).toContain('视频输入')

    await wrapper.get('input[name="batch-workflow-mode"][value="r2r"]').setValue()

    expect(h2rStage?.style.display).toBe('none')
    expect(r2rStage?.style.display).not.toBe('none')
    expect(r2rStage?.textContent).toContain('机器人轨迹输入')
    expect(wrapper.get('#r2r-batch-source-load').text()).toContain('加载源机器人')
    expect(wrapper.get('#r2r-batch-target-load').text()).toContain('加载目标机器人')
    expect(wrapper.get('#r2r-batch-run').text()).toContain('开始 R2R 批量任务')
  })

  it('runs imported videos through GVHMR and adds generated motions to the H2R basket', async () => {
    const bridge = installBridge()
    const { stage, wrapper } = mountWorkflow({ active: true, locale: 'en' })

    await wrapper.get('input[name="batch-workflow-mode"][value="v2m"]').setValue()
    await flushPromises()

    const importButton = Array.from(stage.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Import videos'))
    importButton?.click()
    await flushPromises()

    expect(bridge.pickFiles).toHaveBeenCalledWith(expect.objectContaining({ folder: false }))
    expect(stage.textContent).toContain('walk.mp4')

    const confirmButton = wrapper.findAll('button')
      .find((button) => button.text().includes('Confirm environment'))
    await confirmButton?.trigger('click')

    const runButton = wrapper.findAll('button')
      .find((button) => button.text().includes('Start V2M batch'))
    await runButton?.trigger('click')
    await flushPromises()

    expect(bridge.uploadFilesXHR).toHaveBeenCalledWith(
      '/api/video-to-motion/upload',
      expect.any(Array),
      expect.objectContaining({ staticCam: true }),
      expect.any(Function),
    )
    expect(bridge.waitMotionJob).toHaveBeenCalledWith(
      'job-v2m',
      expect.any(Function),
      { uploadFrac: 0.08 },
    )
    expect(bridge.addToBasket).toHaveBeenCalledWith([bridge.entry], { silent: true })
    expect(bridge.refreshLibrary).toHaveBeenCalled()
    expect(stage.textContent).toContain('Motion ready')
  })

  it('opens the Motion Picker and routes robot imports through request-panel', async () => {
    const { get } = installBridge()
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

    const workspaces = stage.querySelectorAll<HTMLElement>('.batch-stage-workspace')
    expect(workspaces).toHaveLength(3)
    workspaces.forEach((workspace) => expect(workspace.style.display).toBe('none'))
    expect(document.body.querySelector('.motion-picker-dialog')).toBeNull()
  })
})
