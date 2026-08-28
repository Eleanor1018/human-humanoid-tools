import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import SearchField from '../../src/components/SearchField.vue'

const wrappers: Array<ReturnType<typeof mount>> = []

afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('SearchField', () => {
  it('forwards input attributes and exposes accessible search controls', async () => {
    const wrapper = mount(SearchField, {
      props: {
        modelValue: '',
        label: 'Search motions',
        placeholder: 'Find a clip',
        clearLabel: 'Clear motion search',
      },
      attrs: { id: 'lib-search', 'data-library-search': 'true' },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const input = wrapper.get('input')
    expect(input.attributes()).toMatchObject({
      id: 'lib-search',
      'aria-label': 'Search motions',
      placeholder: 'Find a clip',
      'data-library-search': 'true',
      type: 'search',
    })
    expect(wrapper.get('[data-icon="magnifying-glass"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('.search-field-clear').exists()).toBe(false)

    await input.setValue('walk')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['walk'])
    await wrapper.setProps({ modelValue: 'walk' })
    expect(wrapper.get('.search-field-clear').attributes('aria-label')).toBe('Clear motion search')
  })

  it('clears through a bubbling native input event and restores input focus', async () => {
    const wrapper = mount(SearchField, {
      props: {
        modelValue: 'terrain',
        label: 'Search motions',
        clearLabel: 'Clear motion search',
      },
      attrs: { id: 'lib-search' },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    const input = wrapper.get('input').element as HTMLInputElement
    let nativeInputEvents = 0
    input.addEventListener('input', () => { nativeInputEvents += 1 })

    await wrapper.get('.search-field-clear').trigger('click')
    await nextTick()

    expect(input.value).toBe('')
    expect(nativeInputEvents).toBe(1)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([''])
    expect(wrapper.emitted('clear')).toHaveLength(1)
    expect(document.activeElement).toBe(input)
    expect(wrapper.get('[data-icon="x-mark"]').attributes('aria-hidden')).toBe('true')
  })

  it('keeps both the input and clear control disabled', () => {
    const wrapper = mount(SearchField, {
      props: {
        modelValue: 'walk',
        label: 'Search motions',
        disabled: true,
      },
    })
    wrappers.push(wrapper)

    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.search-field-clear').attributes('disabled')).toBeDefined()
  })
})
