<script setup lang="ts">
import { computed } from 'vue'

import type { WorkspaceLocale } from '../runtime/types'

const props = defineProps<{
  side: 'left' | 'right'
  expanded: boolean
  locale: WorkspaceLocale
}>()

const emit = defineEmits<{
  toggle: []
}>()

const controls = computed(() => props.side === 'left' ? 'sidebar' : 'inspector')
const elementId = computed(() => props.side === 'left' ? 'toggle-sidebar' : 'toggle-inspector')

const icon = computed(() => {
  const pointsLeft = props.side === 'left' ? props.expanded : !props.expanded
  return pointsLeft
    ? { name: 'chevron-left', path: 'M15.75 19.5 8.25 12l7.5-7.5' }
    : { name: 'chevron-right', path: 'm8.25 4.5 7.5 7.5-7.5 7.5' }
})

const label = computed(() => {
  const expanding = !props.expanded
  if (props.locale === 'zh-CN') {
    if (props.side === 'left') return expanding ? '展开左侧导航' : '折叠左侧导航'
    return expanding ? '展开右侧控制面板' : '折叠右侧控制面板'
  }
  if (props.side === 'left') return expanding ? 'Expand left navigation' : 'Collapse left navigation'
  return expanding ? 'Expand right inspector' : 'Collapse right inspector'
})
</script>

<template>
  <button
    type="button"
    class="workspace-drawer-handle"
    :class="side"
    :id="elementId"
    :data-state="expanded ? 'expanded' : 'collapsed'"
    :title="label"
    :aria-label="label"
    :aria-controls="controls"
    :aria-expanded="expanded"
    @click="emit('toggle')"
  >
    <!-- Heroicons 24px Outline chevrons (MIT), copied from the official
         tailwindlabs/heroicons repository instead of drawing a local icon. -->
    <svg
      class="workspace-drawer-icon"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      aria-hidden="true"
      data-slot="icon"
      :data-icon="icon.name"
    >
      <path stroke-linecap="round" stroke-linejoin="round" :d="icon.path" />
    </svg>
  </button>
</template>
