<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type {
  JobConfigResponse,
  JobHistoryCommandDetail,
  JobHistoryRecord,
  JobParameterValue,
  JobReplayCapability,
  JobSpecValidationResponse,
  JobStatus,
} from '../runtime/types'

const open = ref(false)
const jobs = ref<JobHistoryRecord[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const editorOpen = ref(false)
const editorTitle = ref('导入任务配置')
const editorText = ref('')
const editorBusy = ref(false)
const editorError = ref<string | null>(null)
const editorValidation = ref<JobReplayCapability | null>(null)

const runningCount = computed(() => jobs.value.filter((job) => job.status === 'running').length)
const failedCount = computed(() => jobs.value.filter((job) => job.status === 'error').length)
const doneCount = computed(() => jobs.value.filter((job) => job.status === 'done').length)
const latestJob = computed(() => jobs.value[0] ?? null)

const KIND_LABELS: Record<string, string> = {
  dataset_analyze: '数据集分析',
  dataset_robot_preview: '机器人轨迹预览',
  motion_load: '加载动作',
  motion_link: '导入动作',
  basket_upload: '导入批量动作',
  retarget: 'H2R Retarget',
  batch: 'H2R 批量任务',
  r2r_source_upload: '加载源机器人轨迹',
  r2r_retarget: 'R2R Retarget',
  r2r_basket_upload: '导入 R2R 批量轨迹',
  r2r_batch: 'R2R 批量任务',
}

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: '等待中',
  running: '运行中',
  done: '已完成',
  error: '失败',
}

const PARAMETER_LABELS: Record<string, string> = {
  robot: '机器人',
  target: '目标机器人',
  target_robot: '目标机器人',
  source_robot: '源机器人',
  source: '数据源',
  profile: '配置',
  reference: '参考骨架',
  backend: '求解器',
  embedding: '特征空间',
  format: '格式',
  retarget_fps: 'Retarget FPS',
  export_fps: 'Export FPS',
  source_fps: 'Source FPS',
  batch_size: 'Batch Size',
  out_dir: '输出目录',
  folder_label: '目录',
  library_folder_label: '资源目录',
  entry_count: '条目',
  file_count: '文件',
}

function receive(event: WindowEventMap['hhtools:job-history-state']): void {
  jobs.value = event.detail.jobs
  loading.value = event.detail.loading
  error.value = event.detail.error
}

function dispatch(detail: JobHistoryCommandDetail): void {
  window.dispatchEvent(new CustomEvent('hhtools:job-history-command', { detail }))
}

function requestRefresh(): void {
  dispatch({ command: 'refresh' })
}

function requestConfig(jobId: string): void {
  dispatch({ command: 'copy-config', jobId })
}

function requestCli(jobId: string): void {
  dispatch({ command: 'copy-cli', jobId })
}

function requestConfigDownload(jobId: string): void {
  dispatch({ command: 'download-config', jobId })
}

function requestDownload(job: JobHistoryRecord): void {
  const filename = job.result_summary.download_name
  dispatch({
    command: 'download',
    jobId: job.id,
    filename: typeof filename === 'string' ? filename : undefined,
  })
}

function appBridge() {
  if (!window.__hhApp) throw new Error('WebUI 尚未准备完成，请稍后重试')
  return window.__hhApp
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function resetEditorValidation(): void {
  editorError.value = null
  editorValidation.value = null
}

function openEditor(title: string, value: unknown): void {
  editorTitle.value = title
  editorText.value = JSON.stringify(value, null, 2)
  resetEditorValidation()
  editorOpen.value = true
}

function closeEditor(): void {
  if (editorBusy.value) return
  editorOpen.value = false
}

function openImportPicker(): void {
  importInput.value?.click()
}

async function importConfig(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    openEditor(`导入配置 · ${file.name}`, JSON.parse(await file.text()) as unknown)
  } catch (caught) {
    appBridge().toast(`读取配置失败：${errorMessage(caught)}`, true)
  }
}

async function duplicateForEdit(job: JobHistoryRecord): Promise<void> {
  try {
    const config: JobConfigResponse = await appBridge().API.get(`/api/job/${job.id}/config`)
    openEditor(`复制编辑 · ${kindLabel(job.kind)}`, config.spec)
  } catch (caught) {
    appBridge().toast(`读取任务配置失败：${errorMessage(caught)}`, true)
  }
}

function parsedEditorValue(): unknown {
  try {
    return JSON.parse(editorText.value) as unknown
  } catch (caught) {
    throw new Error(`JSON 格式错误：${errorMessage(caught)}`)
  }
}

async function validateEditor(): Promise<JobSpecValidationResponse | null> {
  editorBusy.value = true
  resetEditorValidation()
  try {
    const result = await appBridge().API.post('/api/jobs/spec/validate', parsedEditorValue())
    editorValidation.value = result.replay
    editorText.value = JSON.stringify(result.spec, null, 2)
    return result
  } catch (caught) {
    editorError.value = errorMessage(caught)
    return null
  } finally {
    editorBusy.value = false
  }
}

async function runEditor(): Promise<void> {
  const validated = await validateEditor()
  if (!validated || !validated.replay.available) return
  editorBusy.value = true
  try {
    const started = await appBridge().API.post('/api/jobs/replay', {
      spec: validated.spec,
    })
    appBridge().toast(`已创建任务 ${started.job_id}`)
    editorOpen.value = false
    requestRefresh()
  } catch (caught) {
    editorError.value = errorMessage(caught)
  } finally {
    editorBusy.value = false
  }
}

async function retryJob(job: JobHistoryRecord, failedOnly = false): Promise<void> {
  if (failedOnly ? !job.can_retry_failed : !job.can_retry) return
  try {
    const started = await appBridge().API.post('/api/jobs/replay', {
      job_id: job.id,
      failed_only: failedOnly,
    })
    appBridge().toast(
      failedOnly
        ? `已创建失败项重试任务 ${started.job_id}`
        : `已创建重试任务 ${started.job_id}`,
    )
    requestRefresh()
  } catch (caught) {
    appBridge().toast(`重试失败：${errorMessage(caught)}`, true)
  }
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

function statusLabel(status: JobStatus): string {
  return STATUS_LABELS[status]
}

function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp * 1000))
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes} 分 ${remainder} 秒`
}

function parameterEntries(job: JobHistoryRecord): Array<[string, JobParameterValue]> {
  return Object.entries(job.parameters).slice(0, 6)
}

function parameterLabel(key: string): string {
  return PARAMETER_LABELS[key] ?? key
}

function resultText(job: JobHistoryRecord): string {
  const result = job.result_summary
  const parts: string[] = []
  if (typeof result.success_count === 'number') parts.push(`${result.success_count} 成功`)
  if (typeof result.failure_count === 'number' && result.failure_count > 0) {
    parts.push(`${result.failure_count} 失败`)
  }
  if (typeof result.num_frames === 'number') parts.push(`${result.num_frames} 帧`)
  return parts.join(' · ')
}

function progressPercent(job: JobHistoryRecord): number {
  return Math.round(Math.max(0, Math.min(1, job.progress || 0)) * 100)
}

onMounted(() => {
  window.addEventListener('hhtools:job-history-state', receive)
  requestRefresh()
})

onBeforeUnmount(() => window.removeEventListener('hhtools:job-history-state', receive))
</script>

<template>
  <section class="job-drawer" :class="{ open }" aria-label="任务历史">
    <button
      v-if="!open"
      type="button"
      class="job-drawer-summary"
      :aria-expanded="false"
      title="展开任务历史"
      @click="open = true"
    >
      <span class="job-summary-title">任务</span>
      <span v-if="runningCount" class="job-summary-count state-running">{{ runningCount }} 运行中</span>
      <span v-if="failedCount" class="job-summary-count state-error">{{ failedCount }} 失败</span>
      <span v-if="doneCount" class="job-summary-count state-done">{{ doneCount }} 完成</span>
      <span class="job-summary-latest">
        {{ latestJob ? `${kindLabel(latestJob.kind)} · ${latestJob.message || statusLabel(latestJob.status)}` : '暂无任务记录' }}
      </span>
      <span class="job-summary-chevron" aria-hidden="true">⌃</span>
    </button>

    <div v-else class="job-drawer-panel">
      <header class="job-drawer-head">
        <div>
          <strong>任务历史</strong>
          <span>本机持久化 · {{ jobs.length }} 条</span>
        </div>
        <div class="job-drawer-head-actions">
          <input ref="importInput" class="sr-only" type="file" accept="application/json,.json" @change="importConfig">
          <button type="button" class="job-action-btn" title="导入 JobSpec JSON" @click="openImportPicker">导入配置</button>
          <button type="button" class="job-icon-btn" title="刷新任务" aria-label="刷新任务" @click="requestRefresh">↻</button>
          <button type="button" class="job-icon-btn" title="收起任务" aria-label="收起任务" @click="open = false">⌄</button>
        </div>
      </header>

      <p v-if="error" class="job-drawer-error" role="alert">{{ error }}</p>
      <p v-else-if="loading && !jobs.length" class="job-drawer-empty" role="status">正在读取任务…</p>
      <p v-else-if="!jobs.length" class="job-drawer-empty">运行 Retarget、Batch 或数据集分析后，记录会保存在这里。</p>

      <div v-else class="job-list" aria-live="polite">
        <article v-for="job in jobs" :key="job.id" class="job-row" :class="`state-${job.status}`">
          <span class="job-status-dot" aria-hidden="true"></span>
          <div class="job-row-main">
            <div class="job-row-title">
              <strong>{{ kindLabel(job.kind) }}</strong>
              <span class="job-status-label">{{ statusLabel(job.status) }}</span>
              <time :datetime="new Date(job.created_at * 1000).toISOString()">{{ formatTime(job.created_at) }}</time>
              <span>{{ formatDuration(job.duration_seconds) }}</span>
            </div>
            <p v-if="job.error" class="job-row-message error" :title="job.error">{{ job.error }}</p>
            <p v-else class="job-row-message" :title="job.message">{{ job.message || statusLabel(job.status) }}</p>

            <div v-if="job.status === 'running'" class="job-progress" role="progressbar" :aria-valuenow="progressPercent(job)" aria-valuemin="0" aria-valuemax="100">
              <span :style="{ width: `${progressPercent(job)}%` }"></span>
            </div>

            <div v-if="parameterEntries(job).length || resultText(job)" class="job-row-meta">
              <span v-for="([key, value]) in parameterEntries(job)" :key="key">
                {{ parameterLabel(key) }}: {{ value }}
              </span>
              <span v-if="resultText(job)" class="job-result-summary">{{ resultText(job) }}</span>
            </div>
          </div>
          <div class="job-row-actions">
            <button
              type="button"
              class="job-action-btn primary"
              :disabled="!job.can_retry"
              :title="job.can_retry ? '使用保存的源文件和有效参数创建新任务' : (job.retry_reason || '当前任务不可重试')"
              @click="retryJob(job)"
            >重试</button>
            <button
              v-if="job.can_retry_failed"
              type="button"
              class="job-action-btn"
              title="只重新运行上次失败的批处理条目"
              @click="retryJob(job, true)"
            >仅重试失败项 ({{ job.failed_item_count }})</button>
            <button type="button" class="job-action-btn" title="复制为可编辑 JobSpec" @click="duplicateForEdit(job)">复制编辑</button>
            <button v-if="job.can_copy_cli" type="button" class="job-action-btn" title="复制等价的 hhtools CLI 命令" @click="requestCli(job.id)">复制 CLI</button>
            <button type="button" class="job-action-btn" title="复制任务的有效请求配置" @click="requestConfig(job.id)">复制配置</button>
            <button type="button" class="job-action-btn" title="将有效请求配置保存为 JSON" @click="requestConfigDownload(job.id)">保存配置</button>
            <button v-if="job.can_download" type="button" class="job-action-btn primary" title="下载任务结果" @click="requestDownload(job)">下载结果</button>
          </div>
        </article>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="editorOpen" class="job-spec-backdrop" @click.self="closeEditor">
        <section class="job-spec-dialog" role="dialog" aria-modal="true" :aria-label="editorTitle">
          <header class="job-spec-dialog-head">
            <div>
              <strong>{{ editorTitle }}</strong>
              <span>JobSpec v1 · 修改后先验证，再作为新任务运行</span>
            </div>
            <button type="button" class="job-icon-btn" title="关闭" aria-label="关闭" :disabled="editorBusy" @click="closeEditor">×</button>
          </header>
          <textarea
            v-model="editorText"
            class="job-spec-editor"
            spellcheck="false"
            aria-label="JobSpec JSON"
            @input="resetEditorValidation"
          ></textarea>
          <div class="job-spec-feedback" aria-live="polite">
            <p v-if="editorError" class="error">{{ editorError }}</p>
            <p v-else-if="editorValidation?.available" class="ok">
              配置有效，可从 {{ editorValidation.source_count }} 个本地源文件重新运行。
            </p>
            <p v-else-if="editorValidation" class="warning">
              配置格式有效，但不能直接运行：{{ editorValidation.reason }}
            </p>
            <p v-else>支持导入从任务历史下载的完整配置，或独立 JobSpec JSON。</p>
          </div>
          <footer class="job-spec-dialog-actions">
            <button type="button" class="job-action-btn" :disabled="editorBusy" @click="closeEditor">取消</button>
            <button type="button" class="job-action-btn" :disabled="editorBusy" @click="validateEditor">
              {{ editorBusy ? '验证中…' : '验证配置' }}
            </button>
            <button
              type="button"
              class="job-action-btn primary"
              :disabled="editorBusy || editorValidation?.available === false"
              @click="runEditor"
            >作为新任务运行</button>
          </footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>
