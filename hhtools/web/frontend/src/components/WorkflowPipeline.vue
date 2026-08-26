<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

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
    { id: 'solver', label: '求解', state: 'missing', detail: '尚未运行', panel: 'h2r' },
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
const blockedReason = ref<string | null>(null)

const title = computed(() => props.workflow === 'h2r' ? 'H2R Pipeline' : 'R2R Pipeline')

function receive(event: WindowEventMap['hhtools:workflow-state']): void {
  if (event.detail.workflow !== props.workflow) return
  nodes.value = event.detail.nodes
  blockedReason.value = event.detail.blockedReason
}

function openNode(node: WorkflowNodeStatus): void {
  window.dispatchEvent(
    new CustomEvent('hhtools:panel-request', { detail: node.panel }),
  )
}

onMounted(() => window.addEventListener('hhtools:workflow-state', receive))
onBeforeUnmount(() => window.removeEventListener('hhtools:workflow-state', receive))
</script>

<template>
  <section class="workflow-pipeline" :aria-label="title">
    <header class="workflow-pipeline-head">
      <span>{{ title }}</span>
      <span class="workflow-pipeline-legend">点击步骤可定位</span>
    </header>
    <ol class="workflow-pipeline-nodes">
      <li v-for="node in nodes" :key="node.id" class="workflow-pipeline-node">
        <button
          type="button"
          class="workflow-node-button"
          :class="`state-${node.state}`"
          :title="node.detail"
          @click="openNode(node)"
        >
          <span class="workflow-node-dot" aria-hidden="true"></span>
          <span class="workflow-node-label">{{ node.label }}</span>
          <span class="workflow-node-detail">{{ node.detail }}</span>
        </button>
      </li>
    </ol>
    <p v-if="blockedReason" class="workflow-blocked-reason" role="status">
      {{ blockedReason }}
    </p>
  </section>
</template>
