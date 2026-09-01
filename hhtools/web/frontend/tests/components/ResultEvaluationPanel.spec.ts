import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import type { ResultDiagnosticsDetail } from '../../src/runtime/types'
import ResultEvaluationPanel from '../../src/components/ResultEvaluationPanel.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

beforeEach(() => localStorage.clear())
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('ResultEvaluationPanel', () => {
  it('renders diagnostics and requests comparison presets', async () => {
    const wrapper = mount(ResultEvaluationPanel, {
      props: { workflow: 'h2r', locale: 'zh-CN' },
    })
    wrappers.push(wrapper)
    const detail: ResultDiagnosticsDetail = {
      workflow: 'h2r',
      comparisonPreset: 'overlay',
      diagnostics: {
        schema_version: 1,
        available: true,
        frame_count: 2,
        mapped_effectors: 1,
        requested_effectors: 1,
        tracking: {
          mean_error_m: 0.02,
          p95_error_m: 0.04,
          max_error_m: 0.05,
          effectors: [{
            canonical: 'left_ankle',
            target_link: 'left_foot',
            sample_count: 2,
            mean_error_m: 0.02,
            p95_error_m: 0.04,
            max_error_m: 0.05,
          }],
          series: [
            { frame: 0, time_s: 0, mean_error_m: 0.01, max_error_m: 0.02, source_contacts: 1, target_contacts: 1 },
            { frame: 1, time_s: 0.03, mean_error_m: 0.02, max_error_m: 0.05, source_contacts: 1, target_contacts: 1 },
          ],
        },
        contact: {
          available: true,
          agreement_ratio: 1,
          target_slide_mean_mps: 0.01,
          feet: [],
        },
      },
    }
    window.dispatchEvent(new CustomEvent('hhtools:result-diagnostics', { detail }))
    await nextTick()

    expect(wrapper.text()).toContain('2.0 cm')
    expect(wrapper.text()).toContain('100%')
    expect(wrapper.get('.result-quality').text()).toBe('跟踪稳定')
    expect(wrapper.get('[data-preset="source"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.get('[data-preset="overlay"]').attributes('aria-pressed')).toBe('true')

    window.dispatchEvent(new CustomEvent('hhtools:comparison-state', {
      detail: { workflow: 'h2r', preset: 'target' },
    }))
    await nextTick()
    expect(wrapper.get('[data-preset="target"]').classes()).toContain('active')

    window.dispatchEvent(new CustomEvent('hhtools:comparison-state', {
      detail: { workflow: 'h2r', preset: 'result' },
    }))
    await nextTick()
    expect(wrapper.get('[data-preset="result"]').classes()).toContain('active')

    const commands: string[] = []
    const receive = (event: WindowEventMap['hhtools:comparison-command']): void => {
      commands.push(event.detail.preset)
    }
    window.addEventListener('hhtools:comparison-command', receive)
    await wrapper.findAll('.comparison-presets button')[2].trigger('click')
    window.removeEventListener('hhtools:comparison-command', receive)

    expect(commands).toEqual(['result'])

    await wrapper.setProps({ locale: 'en' })
    expect(wrapper.get('.result-quality').text()).toBe('Stable tracking')
    expect(wrapper.get('[data-preset="source"]').text()).toBe('Source data')
    expect(wrapper.text()).toContain('Mean error')
  })

  it('relocalizes the built-in unavailable reason without another runtime event', async () => {
    const wrapper = mount(ResultEvaluationPanel, {
      props: { workflow: 'r2r', locale: 'en' },
    })
    wrappers.push(wrapper)
    window.dispatchEvent(new CustomEvent<ResultDiagnosticsDetail>('hhtools:result-diagnostics', {
      detail: {
        workflow: 'r2r',
        comparisonPreset: 'overlay',
        diagnostics: {
          schema_version: 1,
          available: false,
          reason: '当前结果未返回可用的 tracking/contact 诊断。',
        },
      },
    }))
    await nextTick()

    expect(wrapper.text()).toContain(
      'The current result did not return usable tracking/contact diagnostics.',
    )
    await wrapper.setProps({ locale: 'zh-CN' })
    expect(wrapper.text()).toContain('当前结果未返回可用的 tracking/contact 诊断。')
  })
})
