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

const props = withDefaults(defineProps<{
  desktop?: boolean
  locale?: 'en' | 'zh-CN'
}>(), {
  desktop: false,
  locale: 'zh-CN',
})

const DESKTOP_PANEL_HEIGHT_KEY = 'hhtools-desktop-job-panel-height-v1'
const DEFAULT_DESKTOP_PANEL_HEIGHT = 300
const MIN_DESKTOP_PANEL_HEIGHT = 180

function text(en: string, zh: string): string {
  return props.desktop && props.locale === 'en' ? en : zh
}

const open = ref(false)
const panelHeight = ref(loadPanelHeight())
const jobs = ref<JobHistoryRecord[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const editorOpen = ref(false)
const editorTitle = ref(text('Import task configuration', '导入任务配置'))
const editorText = ref('')
const editorBusy = ref(false)
const editorError = ref<string | null>(null)
const editorValidation = ref<JobReplayCapability | null>(null)

const runningCount = computed(() => jobs.value.filter((job) => job.status === 'running').length)
const failedCount = computed(() => jobs.value.filter((job) => job.status === 'error').length)
const doneCount = computed(() => jobs.value.filter((job) => job.status === 'done').length)
const latestJob = computed(() => jobs.value[0] ?? null)
const panelStyle = computed(() => (
  props.desktop && open.value
    ? { '--job-panel-height': `${panelHeight.value}px` }
    : undefined
))

let stopPanelResize: (() => void) | null = null

function loadPanelHeight(): number {
  if (!props.desktop) return DEFAULT_DESKTOP_PANEL_HEIGHT
  const value = Number(localStorage.getItem(DESKTOP_PANEL_HEIGHT_KEY))
  return Number.isFinite(value) && value >= MIN_DESKTOP_PANEL_HEIGHT
    ? value
    : DEFAULT_DESKTOP_PANEL_HEIGHT
}

function togglePanel(): void {
  open.value = !open.value
}

function handlePanelShortcut(event: KeyboardEvent): void {
  if (!props.desktop || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== 'j') return
  event.preventDefault()
  togglePanel()
}

function startPanelResize(event: PointerEvent): void {
  if (!props.desktop || !open.value) return
  event.preventDefault()

  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const startY = event.clientY
  const startHeight = panelHeight.value
  const previousCursor = document.body.style.cursor
  const previousUserSelect = document.body.style.userSelect

  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'

  const move = (moveEvent: PointerEvent): void => {
    const maxHeight = Math.max(MIN_DESKTOP_PANEL_HEIGHT, window.innerHeight - 160)
    panelHeight.value = Math.min(
      maxHeight,
      Math.max(MIN_DESKTOP_PANEL_HEIGHT, startHeight + startY - moveEvent.clientY),
    )
  }
  const stop = (): void => {
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousUserSelect
    localStorage.setItem(DESKTOP_PANEL_HEIGHT_KEY, String(Math.round(panelHeight.value)))
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    stopPanelResize = null
  }

  stopPanelResize?.()
  stopPanelResize = stop
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
  window.addEventListener('pointercancel', stop, { once: true })
}

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

const KIND_LABELS_EN: Record<string, string> = {
  dataset_analyze: 'Dataset Analysis',
  dataset_robot_preview: 'Robot Trajectory Preview',
  motion_load: 'Load Motion',
  motion_link: 'Link Motion',
  basket_upload: 'Import Batch Motions',
  retarget: 'H2R Retarget',
  batch: 'H2R Batch',
  r2r_source_upload: 'Load Source Robot Trajectory',
  r2r_retarget: 'R2R Retarget',
  r2r_basket_upload: 'Import R2R Batch Trajectories',
  r2r_batch: 'R2R Batch',
}

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: '等待中',
  running: '运行中',
  done: '已完成',
  error: '失败',
}

const STATUS_LABELS_EN: Record<JobStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Completed',
  error: 'Failed',
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

const PARAMETER_LABELS_EN: Record<string, string> = {
  robot: 'Robot',
  target: 'Target Robot',
  target_robot: 'Target Robot',
  source_robot: 'Source Robot',
  source: 'Source',
  profile: 'Profile',
  reference: 'Reference Skeleton',
  backend: 'Solver',
  embedding: 'Feature Space',
  format: 'Format',
  retarget_fps: 'Retarget FPS',
  export_fps: 'Export FPS',
  source_fps: 'Source FPS',
  batch_size: 'Batch Size',
  out_dir: 'Output Directory',
  folder_label: 'Folder',
  library_folder_label: 'Library Folder',
  entry_count: 'Entries',
  file_count: 'Files',
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
  if (!window.__hhApp) {
    throw new Error(text('The WebUI is not ready yet. Try again shortly.', 'WebUI 尚未准备完成，请稍后重试'))
  }
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

function receiveImportRequest(): void {
  openImportPicker()
}

async function importConfig(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    openEditor(`${text('Import configuration', '导入配置')} · ${file.name}`, JSON.parse(await file.text()) as unknown)
  } catch (caught) {
    appBridge().toast(`${text('Unable to read configuration', '读取配置失败')}：${errorMessage(caught)}`, true)
  }
}

async function duplicateForEdit(job: JobHistoryRecord): Promise<void> {
  try {
    const config: JobConfigResponse = await appBridge().API.get(`/api/job/${job.id}/config`)
    openEditor(`${text('Duplicate and edit', '复制编辑')} · ${kindLabel(job.kind)}`, config.spec)
  } catch (caught) {
    appBridge().toast(`${text('Unable to read task configuration', '读取任务配置失败')}：${errorMessage(caught)}`, true)
  }
}

function parsedEditorValue(): unknown {
  try {
    return JSON.parse(editorText.value) as unknown
  } catch (caught) {
    throw new Error(`${text('Invalid JSON', 'JSON 格式错误')}：${errorMessage(caught)}`)
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
    appBridge().toast(`${text('Created task', '已创建任务')} ${started.job_id}`)
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
    appBridge().toast(failedOnly
      ? `${text('Created failed-item retry task', '已创建失败项重试任务')} ${started.job_id}`
      : `${text('Created retry task', '已创建重试任务')} ${started.job_id}`)
    requestRefresh()
  } catch (caught) {
    appBridge().toast(`${text('Retry failed', '重试失败')}：${errorMessage(caught)}`, true)
  }
}

function kindLabel(kind: string): string {
  return (props.desktop && props.locale === 'en' ? KIND_LABELS_EN : KIND_LABELS)[kind] ?? kind
}

function statusLabel(status: JobStatus): string {
  return (props.desktop && props.locale === 'en' ? STATUS_LABELS_EN : STATUS_LABELS)[status]
}

function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return text('Unknown time', '时间未知')
  return new Intl.DateTimeFormat(text('en-US', 'zh-CN'), {
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
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} ${text('sec', '秒')}`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes} ${text('min', '分')} ${remainder} ${text('sec', '秒')}`
}

function parameterEntries(job: JobHistoryRecord): Array<[string, JobParameterValue]> {
  return Object.entries(job.parameters).slice(0, 6)
}

function parameterLabel(key: string): string {
  return (props.desktop && props.locale === 'en' ? PARAMETER_LABELS_EN : PARAMETER_LABELS)[key] ?? key
}

function resultText(job: JobHistoryRecord): string {
  const result = job.result_summary
  const parts: string[] = []
  if (typeof result.success_count === 'number') parts.push(`${result.success_count} ${text('succeeded', '成功')}`)
  if (typeof result.failure_count === 'number' && result.failure_count > 0) {
    parts.push(`${result.failure_count} ${text('failed', '失败')}`)
  }
  if (typeof result.num_frames === 'number') parts.push(`${result.num_frames} ${text('frames', '帧')}`)
  return parts.join(' · ')
}

function progressPercent(job: JobHistoryRecord): number {
  return Math.round(Math.max(0, Math.min(1, job.progress || 0)) * 100)
}

onMounted(() => {
  window.addEventListener('hhtools:job-history-state', receive)
  window.addEventListener('hhtools:job-spec-import-request', receiveImportRequest)
  window.addEventListener('keydown', handlePanelShortcut)
  requestRefresh()
})

onBeforeUnmount(() => {
  window.removeEventListener('hhtools:job-history-state', receive)
  window.removeEventListener('hhtools:job-spec-import-request', receiveImportRequest)
  window.removeEventListener('keydown', handlePanelShortcut)
  stopPanelResize?.()
})
</script>

<template>
  <section
    class="job-drawer"
    :class="{ open, 'desktop-job-panel': desktop }"
    :style="panelStyle"
    :aria-label="text('Task history', '任务历史')"
  >
    <div
      v-if="desktop && open"
      class="job-panel-resizer"
      :title="text('Drag to resize the task panel', '拖动调整任务面板高度')"
      aria-hidden="true"
      @pointerdown="startPanelResize"
    ></div>
    <button
      v-if="!open"
      type="button"
      class="job-drawer-summary"
      :aria-expanded="false"
      :title="desktop ? 'Toggle Tasks (Ctrl+J)' : '展开任务历史'"
      @click="togglePanel"
    >
      <span class="job-summary-title">{{ text('Tasks', '任务') }}</span>
      <span v-if="runningCount" class="job-summary-count state-running">{{ runningCount }} {{ text('running', '运行中') }}</span>
      <span v-if="failedCount" class="job-summary-count state-error">{{ failedCount }} {{ text('failed', '失败') }}</span>
      <span v-if="doneCount" class="job-summary-count state-done">{{ doneCount }} {{ text('completed', '完成') }}</span>
      <span class="job-summary-latest">
        {{ latestJob ? `${kindLabel(latestJob.kind)} · ${latestJob.message || statusLabel(latestJob.status)}` : text('No task history', '暂无任务记录') }}
      </span>
      <span class="job-summary-chevron" aria-hidden="true">⌃</span>
    </button>

    <div v-else class="job-drawer-panel">
      <header class="job-drawer-head">
        <div>
          <strong>{{ text('Task History', '任务历史') }}</strong>
          <span>{{ text('Stored locally', '本机持久化') }} · {{ jobs.length }}</span>
        </div>
        <div class="job-drawer-head-actions">
          <input ref="importInput" class="sr-only" type="file" accept="application/json,.json" @change="importConfig">
          <button type="button" class="job-icon-btn" :title="text('Refresh tasks', '刷新任务')" :aria-label="text('Refresh tasks', '刷新任务')" @click="requestRefresh">↻</button>
          <button type="button" class="job-icon-btn" :title="text('Collapse tasks', '收起任务')" :aria-label="text('Collapse tasks', '收起任务')" @click="togglePanel">⌄</button>
        </div>
      </header>

      <p v-if="error" class="job-drawer-error" role="alert">{{ error }}</p>
      <p v-else-if="loading && !jobs.length" class="job-drawer-empty" role="status">{{ text('Loading tasks…', '正在读取任务…') }}</p>
      <p v-else-if="!jobs.length" class="job-drawer-empty">{{ text('Retarget, Batch, and dataset analysis runs will appear here.', '运行 Retarget、Batch 或数据集分析后，记录会保存在这里。') }}</p>

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
              :title="job.can_retry ? text('Create a new task from saved sources and effective parameters', '使用保存的源文件和有效参数创建新任务') : (job.retry_reason || text('This task cannot be retried', '当前任务不可重试'))"
              @click="retryJob(job)"
            >{{ text('Retry', '重试') }}</button>
            <button
              v-if="job.can_retry_failed"
              type="button"
              class="job-action-btn"
              :title="text('Run only the failed items from the previous batch', '只重新运行上次失败的批处理条目')"
              @click="retryJob(job, true)"
            >{{ text('Retry failed only', '仅重试失败项') }} ({{ job.failed_item_count }})</button>
            <button type="button" class="job-action-btn" :title="text('Duplicate as an editable JobSpec', '复制为可编辑 JobSpec')" @click="duplicateForEdit(job)">{{ text('Duplicate & Edit', '复制编辑') }}</button>
            <button v-if="job.can_copy_cli" type="button" class="job-action-btn" :title="text('Copy the equivalent hhtools CLI command', '复制等价的 hhtools CLI 命令')" @click="requestCli(job.id)">{{ text('Copy CLI', '复制 CLI') }}</button>
            <button type="button" class="job-action-btn" :title="text('Copy the effective request configuration', '复制任务的有效请求配置')" @click="requestConfig(job.id)">{{ text('Copy Config', '复制配置') }}</button>
            <button type="button" class="job-action-btn" :title="text('Save the effective request configuration as JSON', '将有效请求配置保存为 JSON')" @click="requestConfigDownload(job.id)">{{ text('Save Config', '保存配置') }}</button>
            <button v-if="job.can_download" type="button" class="job-action-btn primary" :title="text('Download task result', '下载任务结果')" @click="requestDownload(job)">{{ text('Download Result', '下载结果') }}</button>
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
              <span>JobSpec v1 · {{ text('Validate changes before running a new task', '修改后先验证，再作为新任务运行') }}</span>
            </div>
            <button type="button" class="job-icon-btn" :title="text('Close', '关闭')" :aria-label="text('Close', '关闭')" :disabled="editorBusy" @click="closeEditor">×</button>
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
              {{ text('Configuration is valid and can rerun from', '配置有效，可从') }} {{ editorValidation.source_count }} {{ text('local source files.', '个本地源文件重新运行。') }}
            </p>
            <p v-else-if="editorValidation" class="warning">
              {{ text('The configuration is valid but cannot run directly', '配置格式有效，但不能直接运行') }}：{{ editorValidation.reason }}
            </p>
            <p v-else>{{ text('Import a full configuration downloaded from task history or a standalone JobSpec JSON.', '支持导入从任务历史下载的完整配置，或独立 JobSpec JSON。') }}</p>
          </div>
          <footer class="job-spec-dialog-actions">
            <button type="button" class="job-action-btn" :disabled="editorBusy" @click="closeEditor">{{ text('Cancel', '取消') }}</button>
            <button type="button" class="job-action-btn" :disabled="editorBusy" @click="validateEditor">
              {{ editorBusy ? text('Validating…', '验证中…') : text('Validate Config', '验证配置') }}
            </button>
            <button
              type="button"
              class="job-action-btn primary"
              :disabled="editorBusy || editorValidation?.available === false"
              @click="runEditor"
            >{{ text('Run as New Task', '作为新任务运行') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>
