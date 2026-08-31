<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import type {
  WorkspaceLocale,
  WorkflowId,
  WorkflowNodeStatus,
} from '../runtime/types'

const props = withDefaults(defineProps<{
  workflow: WorkflowId
  locale?: WorkspaceLocale
}>(), {
  locale: 'en',
})

const NODE_LABELS: Record<WorkflowId, Record<string, readonly [string, string]>> = {
  h2r: {
    motion: ['Motion', '动作'],
    robot: ['Robot', '机器人'],
    calibration: ['Calibration', '标定'],
    solver: ['Solver', '求解'],
    result: ['Result', '结果'],
  },
  r2r: {
    source: ['Source robot', '源机器人'],
    trajectory: ['Source trajectory', '源轨迹'],
    target: ['Target robot', '目标机器人'],
    calibration: ['Calibration', '标定'],
    result: ['Result', '结果'],
  },
}

function text(en: string, zh: string): string {
  return props.locale === 'zh-CN' ? zh : en
}

function defaultNodes(): WorkflowNodeStatus[] {
  if (props.workflow === 'h2r') {
    return [
      { id: 'motion', label: text('Motion', '动作'), state: 'missing', detail: text('Not selected', '未选择'), panel: 'motion' },
      { id: 'robot', label: text('Robot', '机器人'), state: 'missing', detail: text('Not selected', '未选择'), panel: 'robot-assets' },
      { id: 'calibration', label: text('Calibration', '标定'), state: 'missing', detail: text('Waiting for input', '等待输入'), panel: 'h2r' },
      { id: 'result', label: text('Result', '结果'), state: 'missing', detail: text('No result yet', '尚无结果'), panel: 'h2r' },
    ]
  }
  return [
    { id: 'source', label: text('Source robot', '源机器人'), state: 'missing', detail: text('Not selected', '未选择'), panel: 'r2r' },
    { id: 'trajectory', label: text('Source trajectory', '源轨迹'), state: 'missing', detail: text('Not uploaded', '未上传'), panel: 'r2r' },
    { id: 'target', label: text('Target robot', '目标机器人'), state: 'missing', detail: text('Not selected', '未选择'), panel: 'r2r' },
    { id: 'calibration', label: text('Calibration', '标定'), state: 'missing', detail: text('Waiting for input', '等待输入'), panel: 'r2r' },
    { id: 'result', label: text('Result', '结果'), state: 'missing', detail: text('No result yet', '尚无结果'), panel: 'r2r' },
  ]
}

const nodes = ref(defaultNodes())

const title = computed(() => props.workflow === 'h2r'
  ? text('Human to Robot pipeline', '人体到机器人流程')
  : text('Robot to Robot pipeline', '机器人到机器人流程'))
const visibleNodes = computed(() => (
  props.workflow === 'h2r'
    ? nodes.value.filter((node) => node.id !== 'solver')
    : nodes.value
))

function nodeLabel(node: WorkflowNodeStatus): string {
  const labels = NODE_LABELS[props.workflow][node.id]
  return labels ? text(labels[0], labels[1]) : node.label
}

const NODE_TARGETS: Record<WorkflowId, Record<string, string>> = {
  h2r: {
    calibration: 'h2r-step-calibration',
    result: 'h2r-step-result',
  },
  r2r: {
    source: 'r2r-step-source',
    trajectory: 'r2r-step-trajectory',
    target: 'r2r-step-target',
    calibration: 'r2r-step-calibration',
    result: 'r2r-step-result',
  },
}

function receive(event: WindowEventMap['hhtools:workflow-state']): void {
  if (event.detail.workflow !== props.workflow) return
  nodes.value = event.detail.nodes
}

async function openNode(node: WorkflowNodeStatus): Promise<void> {
  window.dispatchEvent(
    new CustomEvent('hhtools:panel-request', { detail: node.panel }),
  )

  const targetId = NODE_TARGETS[props.workflow][node.id]
  if (!targetId) return

  await nextTick()
  const target = document.getElementById(targetId)
  if (!(target instanceof HTMLDetailsElement)) return

  target.open = true
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

onMounted(() => window.addEventListener('hhtools:workflow-state', receive))
onBeforeUnmount(() => window.removeEventListener('hhtools:workflow-state', receive))
</script>

<template>
  <section class="workflow-pipeline" :class="`workflow-${workflow}-pipeline`" :aria-label="title">
    <ol class="workflow-pipeline-nodes">
      <li v-for="node in visibleNodes" :key="node.id" class="workflow-pipeline-node">
        <button
          type="button"
          class="workflow-node-button"
          :class="`state-${node.state}`"
          :title="node.detail"
          @click="openNode(node)"
        >
          <span class="workflow-node-dot" aria-hidden="true"></span>
          <span class="workflow-node-label">{{ nodeLabel(node) }}</span>
        </button>
      </li>
    </ol>
  </section>
</template>
