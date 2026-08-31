<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import type {
  WorkflowId,
  WorkflowNodeStatus,
} from '../runtime/types'

const props = defineProps<{
  workflow: WorkflowId
}>()

const DEFAULTS: Record<WorkflowId, WorkflowNodeStatus[]> = {
  h2r: [
    { id: 'motion', label: '动作', state: 'missing', detail: '未选择', panel: 'motion' },
    { id: 'robot', label: '机器人', state: 'missing', detail: '未选择', panel: 'robot-assets' },
    { id: 'calibration', label: '标定', state: 'missing', detail: '等待输入', panel: 'h2r' },
    { id: 'result', label: '结果', state: 'missing', detail: '尚无结果', panel: 'h2r' },
  ],
  r2r: [
    { id: 'source', label: '源机器人', state: 'missing', detail: '未选择', panel: 'r2r' },
    { id: 'trajectory', label: '源轨迹', state: 'missing', detail: '未上传', panel: 'r2r' },
    { id: 'target', label: '目标机器人', state: 'missing', detail: '未选择', panel: 'r2r' },
    { id: 'calibration', label: '标定', state: 'missing', detail: '等待输入', panel: 'r2r' },
    { id: 'result', label: '结果', state: 'missing', detail: '尚无结果', panel: 'r2r' },
  ],
}

const nodes = ref(DEFAULTS[props.workflow])

const title = computed(() => props.workflow === 'h2r' ? 'Human to Robot pipeline' : 'Robot to Robot pipeline')
const visibleNodes = computed(() => (
  props.workflow === 'h2r'
    ? nodes.value.filter((node) => node.id !== 'solver')
    : nodes.value
))

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
          <span class="workflow-node-label">{{ node.label }}</span>
        </button>
      </li>
    </ol>
  </section>
</template>
