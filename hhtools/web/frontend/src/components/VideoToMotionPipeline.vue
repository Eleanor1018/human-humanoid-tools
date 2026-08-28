<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

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
}>>(() => {
  const hasVideo = state.value.videoName !== null
  const runtimeReady = state.value.runtimeState === 'ready'
  const weightsReady = state.value.weightSource === 'official' || state.value.checkpointName !== null
  const processing = state.value.stage === 'uploading' || state.value.stage === 'running'

  return [
    {
      id: 'video',
      label: text('Video', '视频'),
      detail: state.value.videoName ?? text('Not selected', '未选择'),
      state: hasVideo ? 'ready' : 'missing',
      panel: 'video',
    },
    {
      id: 'runtime',
      label: text('Runtime / Weights', '环境 / 权重'),
      detail: state.value.weightSource === 'official'
        ? `${state.value.runtimeMessage} · ${text('Official', '官方')}`
        : state.value.checkpointName ?? text('Custom checkpoint not selected', '尚未选择自定义权重'),
      state: state.value.runtimeState === 'checking'
        ? 'validating'
        : !runtimeReady ? 'failed' : weightsReady ? 'ready' : 'missing',
      panel: 'video-to-motion',
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
            : hasVideo && runtimeReady && weightsReady ? 'ready' : 'missing',
      panel: 'video-to-motion',
    },
    {
      id: 'result',
      label: text('Motion', '动作结果'),
      detail: state.value.result?.name ?? text('No result', '尚无结果'),
      state: state.value.result
        ? 'completed'
        : state.value.stage === 'failed' ? 'failed' : 'missing',
      panel: state.value.result ? 'motion' : 'video-to-motion',
    },
  ]
})

const blockedReason = computed(() => {
  if (state.value.runtimeState === 'unavailable') return state.value.runtimeMessage
  if (!state.value.videoName) return text('Select a video before generating motion.', '请先选择待处理视频。')
  if (state.value.weightSource === 'custom' && !state.value.checkpointName) {
    return text('Import a compatible custom checkpoint.', '请导入兼容的自定义权重。')
  }
  if (state.value.stage === 'failed') return state.value.message
  return null
})

function receive(event: WindowEventMap['hhtools:video-to-motion-state']): void {
  state.value = event.detail
}

function openPanel(panel: WorkspacePanelId): void {
  window.dispatchEvent(new CustomEvent('hhtools:panel-request', { detail: panel }))
}

onMounted(() => window.addEventListener('hhtools:video-to-motion-state', receive))
onBeforeUnmount(() => window.removeEventListener('hhtools:video-to-motion-state', receive))
</script>

<template>
  <section class="workflow-pipeline" :aria-label="text('Video to Motion Pipeline', '视频生成动作流程')">
    <header class="workflow-pipeline-head">
      <span>{{ text('Video → Motion Pipeline', '视频 → 动作流程') }}</span>
      <span class="workflow-pipeline-legend">{{ text('Click a step to navigate', '点击步骤可定位') }}</span>
    </header>
    <ol class="workflow-pipeline-nodes video-to-motion-pipeline-nodes">
      <li v-for="node in nodes" :key="node.id" class="workflow-pipeline-node">
        <button
          type="button"
          class="workflow-node-button"
          :class="`state-${node.state}`"
          :title="node.detail"
          @click="openPanel(node.panel)"
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
