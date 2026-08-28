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
        runtimeState: 'ready',
        runtimeMessage: 'Ready · official weights',
        stage: 'completed',
        progress: 1,
        message: 'Motion generated successfully.',
        result: { name: 'gvhmr-run', frames: 120, duration: 4, framerate: 30 },
      },
    }))
    await nextTick()

    expect(wrapper.findAll('.state-completed')).toHaveLength(2)
    expect(wrapper.text()).toContain('gvhmr-run')

    const panels: string[] = []
    const receive = (event: WindowEventMap['hhtools:panel-request']): void => {
      panels.push(event.detail)
    }
    window.addEventListener('hhtools:panel-request', receive)
    await wrapper.findAll('.workflow-node-button')[3]?.trigger('click')
    window.removeEventListener('hhtools:panel-request', receive)

    expect(panels).toEqual(['motion'])
  })
})
