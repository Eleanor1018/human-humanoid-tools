import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import type { ResultDiagnosticsDetail } from '../runtime/types'
import ResultEvaluationPanel from './ResultEvaluationPanel.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

beforeEach(() => localStorage.clear())
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('ResultEvaluationPanel', () => {
  it('renders diagnostics and requests comparison presets', async () => {
    const wrapper = mount(ResultEvaluationPanel, { props: { workflow: 'h2r' } })
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

    const commands: string[] = []
    const receive = (event: WindowEventMap['hhtools:comparison-command']): void => {
      commands.push(event.detail.preset)
    }
    window.addEventListener('hhtools:comparison-command', receive)
    await wrapper.findAll('.comparison-presets button')[2].trigger('click')
    window.removeEventListener('hhtools:comparison-command', receive)

    expect(commands).toEqual(['result'])
  })
})
