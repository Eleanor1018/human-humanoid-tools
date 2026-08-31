import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import HumanToRobotWorkflow from '../../src/components/HumanToRobotWorkflow.vue'
import RobotToRobotWorkflow from '../../src/components/RobotToRobotWorkflow.vue'
import type { HhAppBridge } from '../../src/runtime/types'

const mountedWrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => {
  mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  delete window.__hhApp
  document.body.innerHTML = ''
})

describe('retarget workflow panels', () => {
  it('presents Human to Robot as four compact steps', async () => {
    const wrapper = mount(HumanToRobotWorkflow, {
      props: { locale: 'zh-CN' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)

    expect(wrapper.findAll('.video-workflow-step')).toHaveLength(4)
    expect(wrapper.findAll('.video-workflow-step-summary').map((step) => step.text())).toEqual([
      '1. 动作',
      '2. 目标机器人',
      '3. 标定',
      '4. 结果',
    ])

    await wrapper.get('#h2r-step-motion .btn').trigger('click')
    await nextTick()
    expect(document.body.querySelector('.motion-picker-dialog')).not.toBeNull()
    expect(wrapper.get('#h2r-step-robot .workflow-picker-row').element).toBeInstanceOf(HTMLDivElement)
    expect(wrapper.get('#h2r-robot-load').text()).toContain('加载机器人')
  })

  it('presents Robot to Robot as five compact steps', async () => {
    window.__hhApp = {
      API: { get: vi.fn(async () => ({ entries: [] })) },
    } as unknown as HhAppBridge
    const wrapper = mount(RobotToRobotWorkflow, {
      props: { locale: 'zh-CN' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)

    expect(wrapper.findAll('.video-workflow-step')).toHaveLength(5)
    expect(wrapper.findAll('.video-workflow-step-summary').map((step) => step.text())).toEqual([
      '1. 源机器人',
      '2. 源轨迹',
      '3. 目标机器人',
      '4. 标定',
      '5. 结果',
    ])

    await wrapper.get('#r2r-step-source .workflow-picker-row .btn').trigger('click')
    expect(wrapper.emitted('request-panel')).toEqual([['robot-assets']])
    expect(wrapper.get('#r2r-source-load').text()).toContain('加载机器人')
    expect(wrapper.get('#r2r-target-load').text()).toContain('加载机器人')

    await wrapper.get('#r2r-step-trajectory .workflow-selection-row .btn').trigger('click')
    await nextTick()
    expect(document.body.querySelector('#motion-picker-title')?.textContent).toContain('选择源轨迹')
    expect(wrapper.find('#r2r-step-trajectory .workflow-import-list').exists()).toBe(false)
    expect(wrapper.get('#r2r-trajectory-value').text()).toBe('未加载')
  })
})
