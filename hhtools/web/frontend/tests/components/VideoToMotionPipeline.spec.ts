import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import VideoToMotionPipeline from '../../src/components/VideoToMotionPipeline.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('VideoToMotionPipeline', () => {
  it('reflects runtime progress and opens the generated motion', async () => {
    const wrapper = mount(VideoToMotionPipeline, { props: { locale: 'en' } })
    wrappers.push(wrapper)

    window.dispatchEvent(new CustomEvent('hhtools:video-to-motion-state', {
      detail: {
        videoName: 'run.mp4',
        weightSource: 'official',
        checkpointName: null,
        runtimeState: 'ready',
        runtimeMessage: 'Ready · official weights',
        environmentConfirmed: true,
        stage: 'completed',
        progress: 1,
        message: 'Motion generated successfully.',
        result: { name: 'gvhmr-run', frames: 120, duration: 4, framerate: 30 },
      },
    }))
    await nextTick()

    expect(wrapper.findAll('.state-completed')).toHaveLength(4)
    expect(wrapper.find('.workflow-pipeline-head').exists()).toBe(false)
    expect(wrapper.findAll('.workflow-node-detail')).toHaveLength(0)

    const panels: string[] = []
    const receive = (event: WindowEventMap['hhtools:panel-request']): void => {
      panels.push(event.detail)
    }
    window.addEventListener('hhtools:panel-request', receive)
    await wrapper.findAll('.workflow-node-button')[3]?.trigger('click')
    window.removeEventListener('hhtools:panel-request', receive)

    expect(panels).toEqual(['video-to-motion'])
  })

  it('keeps the environment incomplete until the user confirms it', async () => {
    const wrapper = mount(VideoToMotionPipeline, { props: { locale: 'en' } })
    wrappers.push(wrapper)

    window.dispatchEvent(new CustomEvent('hhtools:video-to-motion-state', {
      detail: {
        videoName: 'run.mp4',
        weightSource: 'official',
        checkpointName: null,
        runtimeState: 'ready',
        runtimeMessage: 'Ready · official weights',
        environmentConfirmed: false,
        stage: 'idle',
        progress: 0,
        message: '',
        result: null,
      },
    }))
    await nextTick()

    expect(wrapper.findAll('.state-completed')).toHaveLength(1)
    expect(wrapper.findAll('.state-ready')).toHaveLength(1)
    expect(wrapper.find('.video-workflow-hint').exists()).toBe(false)

    window.dispatchEvent(new CustomEvent('hhtools:video-to-motion-state', {
      detail: {
        videoName: 'run.mp4',
        weightSource: 'official',
        checkpointName: null,
        runtimeState: 'ready',
        runtimeMessage: 'Ready · official weights',
        environmentConfirmed: true,
        stage: 'idle',
        progress: 0,
        message: '',
        result: null,
      },
    }))
    await nextTick()

    expect(wrapper.findAll('.state-completed')).toHaveLength(2)
    expect(wrapper.findAll('.state-ready')).toHaveLength(1)
  })

  it('identifies a confirmed custom checkpoint as best effort', async () => {
    const wrapper = mount(VideoToMotionPipeline, { props: { locale: 'en' } })
    wrappers.push(wrapper)

    window.dispatchEvent(new CustomEvent('hhtools:video-to-motion-state', {
      detail: {
        videoName: 'run.mp4',
        weightSource: 'custom',
        checkpointName: 'research-weights.anything',
        runtimeState: 'ready',
        runtimeMessage: 'Ready · custom weights (best effort)',
        environmentConfirmed: true,
        stage: 'idle',
        progress: 0,
        message: '',
        result: null,
      },
    }))
    await nextTick()

    const environment = wrapper.findAll('.workflow-node-button')[1]
    expect(environment?.attributes('title')).toBe(
      'Custom: research-weights.anything (best effort)',
    )
    expect(environment?.classes()).toContain('state-completed')
  })
})
