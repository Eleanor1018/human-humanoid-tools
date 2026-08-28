<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import type {
  VideoToMotionStateDetail,
  WorkflowNodeState,
  WorkspaceLocale,
  WorkspacePanelId,
} from '../runtime/types'

const props = withDefaults(defineProps<{
  locale?: WorkspaceLocale
}>(), {
  locale: 'en',
})

const state = ref<VideoToMotionStateDetail>({
  videoName: null,
  weightSource: 'official',
  checkpointName: null,
  runtimeState: 'checking',
  runtimeMessage: 'Checking GVHMR runtime',
  environmentConfirmed: false,
  stage: 'idle',
  progress: 0,
  message: '',
  result: null,
})

function text(en: string, zh: string): string {
  return props.locale === 'zh-CN' ? zh : en
}

const nodes = computed<Array<{
  id: string
  label: string
  detail: string
  state: WorkflowNodeState
  panel: WorkspacePanelId
  target: string
}>>(() => {
  const hasVideo = state.value.videoName !== null
  const runtimeReady = state.value.runtimeState === 'ready'
  const processing = state.value.stage === 'uploading' || state.value.stage === 'running'

  return [
    {
      id: 'video',
      label: text('Select Video', '选择视频'),
      detail: state.value.videoName ?? text('Not selected', '未选择'),
      state: hasVideo ? 'completed' : 'ready',
      panel: 'video-to-motion',
      target: 'gvhmr-step-video',
    },
    {
      id: 'runtime',
      label: text('Environment', '选择环境'),
      detail: state.value.environmentConfirmed
        ? text('Official GVHMR confirmed', '已确认 GVHMR 官方环境')
        : state.value.runtimeMessage,
      state: !runtimeReady
        ? state.value.runtimeState === 'checking' ? 'missing' : 'failed'
        : state.value.environmentConfirmed ? 'completed' : hasVideo ? 'ready' : 'missing',
      panel: 'video-to-motion',
      target: 'gvhmr-step-environment',
    },
    {
      id: 'generate',
      label: text('Generate', '生成'),
      detail: processing
        ? `${Math.round(state.value.progress * 100)}%`
        : state.value.stage === 'completed'
          ? text('Completed', '已完成')
          : state.value.stage === 'failed'
            ? text('Failed', '失败')
            : text('Not started', '未开始'),
      state: processing
        ? 'running'
        : state.value.stage === 'completed'
          ? 'completed'
          : state.value.stage === 'failed'
            ? 'failed'
            : hasVideo && runtimeReady && state.value.environmentConfirmed ? 'ready' : 'missing',
      panel: 'video-to-motion',
      target: 'gvhmr-step-generate',
    },
    {
      id: 'result',
      label: text('Motion Result', '动作结果'),
      detail: state.value.result?.name ?? text('No result', '尚无结果'),
      state: state.value.result
        ? 'completed'
        : state.value.stage === 'failed' ? 'failed' : 'missing',
      panel: 'video-to-motion',
      target: 'gvhmr-step-result',
    },
  ]
})

function receive(event: WindowEventMap['hhtools:video-to-motion-state']): void {
  state.value = event.detail
}

async function openPanel(panel: WorkspacePanelId, target: string): Promise<void> {
  window.dispatchEvent(new CustomEvent('hhtools:panel-request', { detail: panel }))
  await nextTick()
  const element = document.getElementById(target)
  if (element instanceof HTMLDetailsElement) element.open = true
  element?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
}

onMounted(() => window.addEventListener('hhtools:video-to-motion-state', receive))
onBeforeUnmount(() => window.removeEventListener('hhtools:video-to-motion-state', receive))
</script>

<template>
  <section class="workflow-pipeline video-to-motion-pipeline" :aria-label="text('Video to Motion Pipeline', '视频生成动作流程')">
    <ol class="workflow-pipeline-nodes video-to-motion-pipeline-nodes">
      <li v-for="node in nodes" :key="node.id" class="workflow-pipeline-node">
        <button
          type="button"
          class="workflow-node-button"
          :class="`state-${node.state}`"
          :title="node.detail"
          @click="openPanel(node.panel, node.target)"
        >
          <span class="workflow-node-dot" aria-hidden="true"></span>
          <span class="workflow-node-label">{{ node.label }}</span>
        </button>
      </li>
    </ol>
  </section>
</template>
