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
      ],
    }
    window.dispatchEvent(
      new CustomEvent<WorkflowStateDetail>('hhtools:workflow-state', { detail: state }),
    )
    await nextTick()

    expect(wrapper.findAll('.workflow-pipeline-node')).toHaveLength(2)
    expect(wrapper.get('.state-ready').text()).toContain('walk.npz')
    expect(wrapper.get('.workflow-blocked-reason').text()).toBe(state.blockedReason)

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
