<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'

import type {
  CalibrationEditorCommand,
  CalibrationEditorCommandDetail,
  CalibrationEditorStateDetail,
  CalibrationJointRegion,
  WorkspaceLocale,
  WorkflowId,
} from '../runtime/types'

const props = withDefaults(defineProps<{
  workflow: WorkflowId
  locale?: WorkspaceLocale
}>(), {
  locale: 'en',
})

const state = reactive<CalibrationEditorStateDetail>({
  workflow: props.workflow,
  active: false,
  totalJoints: 0,
  visibleJoints: 0,
  mappedLandmarks: 0,
  canUseSaved: false,
  query: '',
  region: 'all',
  unit: 'rad',
  comparison: 'current',
  mappedOnly: true,
  labels: true,
  mappingLines: true,
  sourceOpacity: 0.82,
  robotOpacity: 0.72,
})

function text(en: string, zh: string): string {
  return props.locale === 'zh-CN' ? zh : en
}

const regions = computed<Array<{ value: CalibrationJointRegion | 'all'; label: string }>>(() => [
  { value: 'all', label: text('All', '全部') },
  { value: 'torso', label: text('Torso', '躯干') },
  { value: 'left-arm', label: text('Left arm', '左臂') },
  { value: 'right-arm', label: text('Right arm', '右臂') },
  { value: 'left-leg', label: text('Left leg', '左腿') },
  { value: 'right-leg', label: text('Right leg', '右腿') },
  { value: 'head', label: text('Head', '头部') },
  { value: 'hands', label: text('Hands', '手部') },
])

const resultCount = computed(() => `${state.visibleJoints} / ${state.totalJoints}`)

function send(command: CalibrationEditorCommand, value?: string | number | boolean): void {
  const detail: CalibrationEditorCommandDetail = {
    workflow: props.workflow,
    command,
    value,
  }
  window.dispatchEvent(new CustomEvent('hhtools:calibration-editor-command', { detail }))
}

function receive(event: WindowEventMap['hhtools:calibration-editor-state']): void {
  if (event.detail.workflow !== props.workflow) return
  Object.assign(state, event.detail)
}

function updateSearch(event: Event): void {
  send('search', (event.currentTarget as HTMLInputElement).value)
}

function updateBoolean(command: CalibrationEditorCommand, event: Event): void {
  send(command, (event.currentTarget as HTMLInputElement).checked)
}

function updateNumber(command: CalibrationEditorCommand, event: Event): void {
  send(command, Number((event.currentTarget as HTMLInputElement).value))
}

onMounted(() => window.addEventListener('hhtools:calibration-editor-state', receive))
onBeforeUnmount(() => window.removeEventListener('hhtools:calibration-editor-state', receive))
</script>

<template>
  <section class="calibration-editor-tools" :aria-label="text(`${workflow.toUpperCase()} calibration controls`, `${workflow.toUpperCase()} 标定控件`)">
    <div class="calibration-tool-row calibration-search-row">
      <label class="calibration-search-field">
        <span class="sr-only">{{ text('Search joints', '搜索关节') }}</span>
        <input
          type="search"
          :value="state.query"
          :placeholder="text('Search joints', '搜索关节')"
          autocomplete="off"
          @input="updateSearch"
        />
      </label>
      <span class="calibration-result-count" :title="text('Visible joint count', '当前显示的关节数')">{{ resultCount }}</span>
      <div class="calibration-segmented" :aria-label="text('Angle unit', '角度单位')">
        <button type="button" :class="{ active: state.unit === 'rad' }" @click="send('unit', 'rad')">rad</button>
        <button type="button" :class="{ active: state.unit === 'deg' }" @click="send('unit', 'deg')">deg</button>
      </div>
    </div>

    <div class="calibration-region-tabs" :aria-label="text('Joint regions', '关节分组')">
      <button
        v-for="region in regions"
        :key="region.value"
        type="button"
        :class="{ active: state.region === region.value }"
        :aria-pressed="state.region === region.value"
        @click="send('region', region.value)"
      >
        {{ region.label }}
      </button>
    </div>

    <div class="calibration-tool-row calibration-comparison-row">
      <span class="calibration-tool-label">{{ text('Pose comparison', '姿态对照') }}</span>
      <div class="calibration-segmented calibration-comparison" :aria-label="text('Pose comparison', '姿态对照')">
        <button type="button" :class="{ active: state.comparison === 'current' }" @click="send('comparison', 'current')">{{ text('Current edit', '当前编辑') }}</button>
        <button type="button" :disabled="!state.canUseSaved" :class="{ active: state.comparison === 'saved' }" @click="send('comparison', 'saved')">{{ text('Saved', '已保存') }}</button>
        <button type="button" :class="{ active: state.comparison === 'zero' }" @click="send('comparison', 'zero')">{{ text('URDF zero', 'URDF 零位') }}</button>
      </div>
      <button type="button" class="calibration-reset-region" @click="send('reset-region')">{{ text('Zero current region', '当前分组归零') }}</button>
    </div>

    <div class="calibration-tool-row calibration-visibility-row">
      <span class="calibration-tool-label">{{ text('Stage display', '舞台显示') }}</span>
      <label><input type="checkbox" :checked="state.mappedOnly" @change="updateBoolean('mapped-only', $event)" />{{ text('Mapped only', '仅映射点') }}</label>
      <label><input type="checkbox" :checked="state.labels" @change="updateBoolean('labels', $event)" />{{ text('Semantic labels', '语义标签') }}</label>
      <label><input type="checkbox" :checked="state.mappingLines" @change="updateBoolean('mapping-lines', $event)" />{{ text('Mapping lines', '映射线') }}</label>
      <span class="calibration-landmark-count">{{ text(`${state.mappedLandmarks} mapped`, `${state.mappedLandmarks} 个映射`) }}</span>
    </div>

    <div class="calibration-opacity-grid">
      <label>
        <span>{{ text('Reference skeleton', '参考骨架') }}</span>
        <input type="range" min="0.15" max="1" step="0.05" :value="state.sourceOpacity" @input="updateNumber('source-opacity', $event)" />
      </label>
      <label>
        <span>{{ text('Target robot', '目标机器人') }}</span>
        <input type="range" min="0.2" max="1" step="0.05" :value="state.robotOpacity" @input="updateNumber('robot-opacity', $event)" />
      </label>
    </div>
  </section>
</template>
