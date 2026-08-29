import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import DataAnalysisPipeline from '../../src/components/DataAnalysisPipeline.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('DataAnalysisPipeline', () => {
  it('reflects selected data and completed analysis results', async () => {
    const wrapper = mount(DataAnalysisPipeline, { props: { locale: 'en' } })
    wrappers.push(wrapper)

    window.dispatchEvent(new CustomEvent('hhtools:data-analysis-state', {
      detail: {
        dataKind: 'robot',
        clipCount: 12,
        stage: 'completed',
        progress: 1,
        message: 'Completed',
        hasResults: true,
      },
    }))
    await nextTick()

    expect(wrapper.findAll('.state-completed')).toHaveLength(4)
    expect(wrapper.text()).toContain('Select Data')
    expect(wrapper.findAll('.workflow-node-detail')).toHaveLength(0)
  })

  it('keeps later steps unavailable before a source is selected', () => {
    const wrapper = mount(DataAnalysisPipeline, { props: { locale: 'zh-CN' } })
    wrappers.push(wrapper)

    expect(wrapper.findAll('.state-ready')).toHaveLength(1)
    expect(wrapper.findAll('.state-missing')).toHaveLength(3)
    expect(wrapper.text()).toContain('选择数据')
  })
})
