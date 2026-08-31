import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import type { WorkflowStateDetail } from '../../src/runtime/types'
import WorkflowPipeline from '../../src/components/WorkflowPipeline.vue'

const mountedWrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => {
  mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('WorkflowPipeline', () => {
  it('renders runtime state and lets users jump to the related workspace', async () => {
    const wrapper = mount(WorkflowPipeline, {
      props: { workflow: 'h2r' },
    })
    mountedWrappers.push(wrapper)

    const state: WorkflowStateDetail = {
      workflow: 'h2r',
      blockedReason: '缺少目标机器人。',
      nodes: [
        { id: 'motion', label: '动作', state: 'ready', detail: 'walk.npz', panel: 'motion' },
        { id: 'robot', label: '机器人', state: 'missing', detail: '未选择', panel: 'robot-assets' },
        { id: 'calibration', label: '标定', state: 'missing', detail: '等待输入', panel: 'h2r' },
        { id: 'solver', label: '求解', state: 'missing', detail: '尚未运行', panel: 'h2r' },
        { id: 'result', label: '结果', state: 'missing', detail: '尚无结果', panel: 'h2r' },
      ],
    }
    window.dispatchEvent(
      new CustomEvent<WorkflowStateDetail>('hhtools:workflow-state', { detail: state }),
    )
    await nextTick()

    expect(wrapper.findAll('.workflow-pipeline-node')).toHaveLength(4)
    expect(wrapper.text()).not.toContain('求解')
    expect(wrapper.get('.state-ready').text()).toBe('动作')
    expect(wrapper.get('.state-ready').attributes('title')).toBe('walk.npz')
    expect(wrapper.find('.workflow-pipeline-head').exists()).toBe(false)
    expect(wrapper.find('.workflow-node-detail').exists()).toBe(false)
    expect(wrapper.find('.workflow-blocked-reason').exists()).toBe(false)

    const requests: string[] = []
    const receiveRequest = (event: WindowEventMap['hhtools:panel-request']): void => {
      requests.push(event.detail)
    }
    window.addEventListener('hhtools:panel-request', receiveRequest)
    await wrapper.get('.state-missing').trigger('click')
    window.removeEventListener('hhtools:panel-request', receiveRequest)

    expect(requests).toEqual(['robot-assets'])
  })
})
