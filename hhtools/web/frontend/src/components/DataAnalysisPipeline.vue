<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import type {
  DataAnalysisStateDetail,
  WorkflowNodeState,
  WorkspaceLocale,
} from '../runtime/types'

const props = withDefaults(defineProps<{
  locale?: WorkspaceLocale
}>(), {
  locale: 'en',
})

const state = ref<DataAnalysisStateDetail>({
  dataKind: 'unknown',
  clipCount: 0,
  stage: 'idle',
  progress: 0,
  message: '',
  hasResults: false,
})

function text(en: string, zh: string): string {
  return props.locale === 'zh-CN' ? zh : en
}

const nodes = computed<Array<{
  id: string
  label: string
  detail: string
  state: WorkflowNodeState
  target: string
}>>(() => {
  const hasSource = state.value.clipCount > 0
  const processing = state.value.stage === 'uploading' || state.value.stage === 'running'
  const kindLabel = state.value.dataKind === 'robot'
    ? text('Robot', '机器人')
    : state.value.dataKind === 'human'
      ? text('Motion', '动作')
      : text('No data', '未选择')

  return [
    {
      id: 'source',
      label: text('Select Data', '选择数据'),
      detail: hasSource ? `${kindLabel} · ${state.value.clipCount} clips` : kindLabel,
      state: state.value.stage === 'uploading' ? 'running' : hasSource ? 'completed' : 'ready',
      target: 'dv-step-source',
    },
    {
      id: 'configure',
      label: text('Configure', '分析配置'),
      detail: text('Embedding and cache', '特征与缓存设置'),
      state: state.value.stage === 'running' || state.value.stage === 'completed'
        ? 'completed'
        : hasSource ? 'ready' : 'missing',
      target: 'dv-step-configure',
    },
    {
      id: 'analyze',
      label: text('Analyze', '运行分析'),
      detail: processing
        ? `${Math.round(state.value.progress * 100)}%`
        : state.value.stage === 'completed'
          ? text('Completed', '已完成')
          : state.value.stage === 'failed'
            ? text('Failed', '失败')
            : text('Not started', '未开始'),
      state: state.value.stage === 'running'
        ? 'running'
        : state.value.stage === 'completed'
          ? 'completed'
          : state.value.stage === 'failed'
            ? 'failed'
            : hasSource ? 'ready' : 'missing',
      target: 'dv-step-analyze',
    },
    {
      id: 'results',
      label: text('Results', '分析结果'),
      detail: state.value.hasResults ? text('Ready', '可查看') : text('No results', '暂无结果'),
      state: state.value.hasResults ? 'completed' : 'missing',
      target: 'dv-step-results',
    },
  ]
})

function receive(event: WindowEventMap['hhtools:data-analysis-state']): void {
  state.value = event.detail
}

async function openStep(target: string): Promise<void> {
  await nextTick()
  const element = document.getElementById(target)
  if (element instanceof HTMLDetailsElement) element.open = true
  element?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
}

onMounted(() => window.addEventListener('hhtools:data-analysis-state', receive))
onBeforeUnmount(() => window.removeEventListener('hhtools:data-analysis-state', receive))
</script>

<template>
  <section class="workflow-pipeline data-analysis-pipeline" :aria-label="text('Data Analysis Pipeline', '数据分析流程')">
    <ol class="workflow-pipeline-nodes data-analysis-pipeline-nodes">
      <li v-for="node in nodes" :key="node.id" class="workflow-pipeline-node">
        <button
          type="button"
          class="workflow-node-button"
          :class="`state-${node.state}`"
          :title="node.detail"
          @click="openStep(node.target)"
        >
          <span class="workflow-node-dot" aria-hidden="true"></span>
          <span class="workflow-node-label">{{ node.label }}</span>
        </button>
      </li>
    </ol>
  </section>
</template>
