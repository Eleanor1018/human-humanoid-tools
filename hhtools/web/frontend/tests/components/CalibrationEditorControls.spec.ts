import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import type { CalibrationEditorCommandDetail, CalibrationEditorStateDetail } from '../../src/runtime/types'
import CalibrationEditorControls from '../../src/components/CalibrationEditorControls.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('CalibrationEditorControls', () => {
  it('renders runtime state and emits typed commands', async () => {
    const wrapper = mount(CalibrationEditorControls, {
      props: { workflow: 'h2r', locale: 'zh-CN' },
    })
    wrappers.push(wrapper)

    const state: CalibrationEditorStateDetail = {
      workflow: 'h2r',
      active: true,
      totalJoints: 29,
      visibleJoints: 7,
      mappedLandmarks: 17,
      canUseSaved: true,
      query: '',
      region: 'left-arm',
      unit: 'deg',
      comparison: 'saved',
      mappedOnly: true,
      labels: true,
      mappingLines: false,
      sourceOpacity: 0.8,
      robotOpacity: 0.7,
    }
    window.dispatchEvent(new CustomEvent('hhtools:calibration-editor-state', { detail: state }))
    await nextTick()

    expect(wrapper.get('.calibration-result-count').text()).toBe('7 / 29')
    expect(wrapper.get('.calibration-landmark-count').text()).toContain('17')
    expect(wrapper.find('.calibration-region-tabs button.active').text()).toBe('左臂')

    const commands: CalibrationEditorCommandDetail[] = []
    const receive = (event: WindowEventMap['hhtools:calibration-editor-command']): void => {
      commands.push(event.detail)
    }
    window.addEventListener('hhtools:calibration-editor-command', receive)
    await wrapper.get('input[type="search"]').setValue('shoulder')
    await wrapper.findAll('.calibration-region-tabs button')[2].trigger('click')
    window.removeEventListener('hhtools:calibration-editor-command', receive)

    expect(commands).toEqual([
      { workflow: 'h2r', command: 'search', value: 'shoulder' },
      { workflow: 'h2r', command: 'region', value: 'left-arm' },
    ])

    await wrapper.setProps({ locale: 'en' })
    expect(wrapper.find('.calibration-region-tabs button.active').text()).toBe('Left arm')
    expect(wrapper.get('input[type="search"]').attributes('placeholder')).toBe('Search joints')
    expect(wrapper.text()).toContain('17 mapped')
  })
})
