import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import type {
  JobHistoryCommandDetail,
  JobHistoryStateDetail,
  HhAppBridge,
} from '../../src/runtime/types'
import JobDrawer from '../../src/components/JobDrawer.vue'

const mountedWrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => {
  mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  delete window.__hhApp
})

describe('JobDrawer', () => {
  it('docks as a collapsed desktop panel and toggles with Ctrl+J', async () => {
    localStorage.removeItem('hhtools-desktop-job-panel-height-v1')
    const wrapper = mount(JobDrawer, {
      props: { desktop: true, locale: 'en' },
    })
    mountedWrappers.push(wrapper)

    expect(wrapper.classes()).toContain('desktop-job-panel')
    expect(wrapper.classes()).not.toContain('open')
    expect(wrapper.find('.job-panel-resizer').exists()).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }))
    await nextTick()

    expect(wrapper.classes()).toContain('open')
    expect(wrapper.find('.job-panel-resizer').exists()).toBe(true)
    expect(wrapper.attributes('style')).toContain('--job-panel-height: 300px')
    expect(wrapper.text()).not.toContain('Import Config')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }))
    await nextTick()
    expect(wrapper.classes()).not.toContain('open')
  })

  it('renders persistent job state and emits reproduction and download commands', async () => {
    const commands: JobHistoryCommandDetail[] = []
    const receiveCommand = (event: WindowEventMap['hhtools:job-history-command']): void => {
      commands.push(event.detail)
    }
    window.addEventListener('hhtools:job-history-command', receiveCommand)

    const wrapper = mount(JobDrawer)
    mountedWrappers.push(wrapper)
    expect(commands).toEqual([{ command: 'refresh' }])

    const state: JobHistoryStateDetail = {
      loading: false,
      error: null,
      jobs: [
        {
          id: 'running-job',
          kind: 'retarget',
          status: 'running',
          progress: 0.42,
          clip_progress: 0,
          message: '正在求解',
          error: null,
          created_at: 1_800_000_000,
          finished_at: null,
          duration_seconds: 8,
          parameters: { robot: 'unitree_g1', backend: 'newton' },
          result_summary: {},
          can_download: false,
          can_copy_cli: true,
          can_retry: false,
          retry_reason: '任务仍在运行中。',
          can_retry_failed: false,
          failed_item_count: 0,
          parent_job_id: null,
          scope: 'current_session',
        },
        {
          id: 'batch-job',
          kind: 'batch',
          status: 'done',
          progress: 1,
          clip_progress: 1,
          message: '2 成功',
          error: null,
          created_at: 1_799_999_000,
          finished_at: 1_799_999_010,
          duration_seconds: 10,
          parameters: { entry_count: 2 },
          result_summary: { success_count: 2, download_name: 'batch.zip' },
          can_download: true,
          can_copy_cli: false,
          can_retry: false,
          retry_reason: '源文件已不存在。',
          can_retry_failed: false,
          failed_item_count: 0,
          parent_job_id: null,
          scope: 'persistent',
        },
      ],
    }
    window.dispatchEvent(
      new CustomEvent<JobHistoryStateDetail>('hhtools:job-history-state', { detail: state }),
    )
    await nextTick()

    expect(wrapper.get('.job-drawer-summary').text()).toContain('1 运行中')
    await wrapper.get('.job-drawer-summary').trigger('click')
    expect(wrapper.findAll('.job-row')).toHaveLength(2)
    expect(wrapper.get('.job-progress').attributes('aria-valuenow')).toBe('42')
    expect(wrapper.text()).toContain('机器人: unitree_g1')

    const action = (label: string) => wrapper.findAll('.job-action-btn').find(
      (button) => button.text() === label,
    )!
    await action('复制 CLI').trigger('click')
    await action('复制配置').trigger('click')
    await action('保存配置').trigger('click')
    await action('下载结果').trigger('click')
    window.removeEventListener('hhtools:job-history-command', receiveCommand)

    expect(commands).toEqual([
      { command: 'refresh' },
      { command: 'copy-cli', jobId: 'running-job' },
      { command: 'copy-config', jobId: 'running-job' },
      { command: 'download-config', jobId: 'running-job' },
      { command: 'download', jobId: 'batch-job', filename: 'batch.zip' },
    ])
  })

  it('starts a replayable job through the typed WebUI bridge', async () => {
    const post = vi.fn().mockResolvedValue({
      job_id: 'retry-job',
      parent_job_id: 'source-job',
      spec: { schema_version: 1, kind: 'retarget', request: {} },
    })
    const toast = vi.fn()
    window.__hhApp = {
      API: {
        get: vi.fn(),
        post,
        upload: vi.fn(),
        delete: vi.fn(),
      },
      toast,
    } as unknown as HhAppBridge

    const wrapper = mount(JobDrawer)
    mountedWrappers.push(wrapper)
    window.dispatchEvent(new CustomEvent<JobHistoryStateDetail>('hhtools:job-history-state', {
      detail: {
        loading: false,
        error: null,
        jobs: [{
          id: 'source-job',
          kind: 'retarget',
          status: 'done',
          progress: 1,
          clip_progress: 1,
          message: 'done',
          error: null,
          created_at: 1_800_000_000,
          finished_at: 1_800_000_010,
          duration_seconds: 10,
          parameters: { robot: 'unitree_g1' },
          result_summary: {},
          can_download: false,
          can_copy_cli: true,
          can_retry: true,
          retry_reason: null,
          can_retry_failed: false,
          failed_item_count: 0,
          parent_job_id: null,
          scope: 'persistent',
        }],
      },
    }))
    await nextTick()
    await wrapper.get('.job-drawer-summary').trigger('click')
    const retry = wrapper.findAll('.job-action-btn').find((button) => button.text() === '重试')
    expect(retry).toBeTruthy()

    await retry!.trigger('click')
    await flushPromises()

    expect(post).toHaveBeenCalledWith('/api/jobs/replay', {
      job_id: 'source-job',
      failed_only: false,
    })
    expect(toast).toHaveBeenCalledWith('已创建重试任务 retry-job')
  })
})
