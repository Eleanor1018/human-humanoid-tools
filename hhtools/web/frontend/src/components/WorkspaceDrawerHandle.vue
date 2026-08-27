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

const glyph = computed(() => {
  if (props.side === 'left') return props.expanded ? '‹' : '›'
  // The right drawer mirrors the left: its closing direction points outward.
  return props.expanded ? '›' : '‹'
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
    <span aria-hidden="true">{{ glyph }}</span>
  </button>
</template>
