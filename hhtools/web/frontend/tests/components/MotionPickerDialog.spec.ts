import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import MotionPickerDialog from '../../src/components/MotionPickerDialog.vue'
import type { HhAppBridge, LibraryEntry } from '../../src/runtime/types'

const wrappers: Array<ReturnType<typeof mount>> = []

const entries: LibraryEntry[] = [
  {
    folder_label: 'LAFAN',
    stem: 'walk_forward',
    source_path: 'C:/motions/walk_forward.npz',
    motion_category: 'motion',
    asset_kind: 'human_motion',
  },
  {
    folder_label: 'InterMimic',
    stem: 'carry_box',
    source_path: 'C:/motions/carry_box.npz',
    motion_category: 'object',
    asset_kind: 'human_motion',
  },
  {
    dataset: 'robot',
    folder_label: 'G1 exports',
    stem: 'walk_forward_g1',
    source_path: 'C:/robot-trajectories/walk_forward_g1.npz',
    motion_category: 'motion',
    asset_kind: 'robot_trajectory',
  },
]

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  delete window.__hhApp
  document.body.innerHTML = ''
})

function installBridge() {
  const loadLibraryEntry = vi.fn(async () => undefined)
  const loadHumanMotionEntry = vi.fn(async () => undefined)
  const loadR2rLibraryEntry = vi.fn(async () => undefined)
  const addToBasket = vi.fn()
  window.__hhApp = {
    API: { get: vi.fn(async () => ({ entries })) },
    loadLibraryEntry,
    loadHumanMotionEntry,
    loadR2rLibraryEntry,
    addToBasket,
  } as unknown as HhAppBridge
  return { loadLibraryEntry, loadHumanMotionEntry, loadR2rLibraryEntry, addToBasket }
}

describe('MotionPickerDialog', () => {
  it('loads, searches, filters, and selects a Motion Library entry', async () => {
    const { loadHumanMotionEntry } = installBridge()
    const wrapper = mount(MotionPickerDialog, {
      props: { open: true, locale: 'zh-CN' },
      attachTo: document.body,
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(document.body.querySelectorAll('.motion-picker-row')).toHaveLength(2)
    const filter = document.body.querySelector('.motion-picker-filter') as HTMLSelectElement
    filter.value = 'object'
    filter.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const rows = document.body.querySelectorAll<HTMLButtonElement>('.motion-picker-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('carry_box')
    rows[0]?.click()
    await flushPromises()

    expect(loadHumanMotionEntry).toHaveBeenCalledWith(entries[1])
    expect(wrapper.emitted('selected')).toEqual([[entries[1]]])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('keeps robot trajectories out of H2R and loads them only through the R2R bridge', async () => {
    const { loadHumanMotionEntry, loadR2rLibraryEntry } = installBridge()
    const wrapper = mount(MotionPickerDialog, {
      props: {
        open: true,
        locale: 'zh-CN',
        assetKind: 'robot_trajectory',
      },
      attachTo: document.body,
    })
    wrappers.push(wrapper)
    await flushPromises()

    const rows = document.body.querySelectorAll<HTMLButtonElement>('.motion-picker-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('walk_forward_g1')
    expect(document.body.querySelector('#motion-picker-title')?.textContent).toContain('选择源轨迹')
    rows[0]?.click()
    await flushPromises()

    expect(loadR2rLibraryEntry).toHaveBeenCalledWith(entries[2])
    expect(loadHumanMotionEntry).not.toHaveBeenCalled()
  })

  it('keeps Batch open while toggling multiple entries, then adds them together', async () => {
    const { addToBasket } = installBridge()
    const wrapper = mount(MotionPickerDialog, {
      props: { open: true, mode: 'basket', locale: 'zh-CN' },
      attachTo: document.body,
    })
    wrappers.push(wrapper)
    await flushPromises()

    const rows = document.body.querySelectorAll<HTMLButtonElement>('.motion-picker-row')
    const addButton = document.body.querySelector<HTMLButtonElement>('.motion-picker-add-selected')
    expect(document.body.querySelector('.motion-picker-list')?.getAttribute('aria-multiselectable')).toBe('true')
    expect(addButton?.disabled).toBe(true)

    rows[0]?.click()
    await flushPromises()
    expect(addToBasket).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true')
    expect(document.body.querySelector('.motion-picker-selection-count')?.textContent).toContain('已选择 1 条')

    rows[1]?.click()
    await flushPromises()
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true')
    expect(document.body.querySelector('.motion-picker-selection-count')?.textContent).toContain('已选择 2 条')
    expect(addButton?.textContent).toContain('添加 2 条动作')

    rows[0]?.click()
    await flushPromises()
    expect(rows[0]?.getAttribute('aria-selected')).toBe('false')
    expect(addButton?.textContent).toContain('添加 1 条动作')

    addButton?.click()
    await flushPromises()
    expect(addToBasket).toHaveBeenCalledTimes(1)
    expect(addToBasket).toHaveBeenCalledWith([entries[1]])
    expect(wrapper.emitted('selected')).toEqual([[entries[1]]])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
