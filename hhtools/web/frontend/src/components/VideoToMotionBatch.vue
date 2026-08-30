<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type {
  GvhmrRuntimeStatus,
  HhAppBridge,
  LibraryEntry,
  MotionPayload,
  UploadFile,
  WorkspaceLocale,
} from '../runtime/types'

type VideoStatus = 'queued' | 'uploading' | 'running' | 'done' | 'error'

interface BatchVideo {
  id: string
  file: UploadFile
  progress: number
  status: VideoStatus
  message: string
  result?: LibraryEntry
}

const props = withDefaults(defineProps<{
  active: boolean
  locale?: WorkspaceLocale
}>(), {
  locale: 'en',
})

const VIDEO_SUFFIXES = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'])
const VIDEO_ACCEPT = '.mp4,.mov,.mkv,.avi,.webm,.m4v,video/*'

const videos = ref<BatchVideo[]>([])
const runtime = ref<GvhmrRuntimeStatus | null>(null)
const runtimeChecking = ref(false)
const runtimeError = ref('')
const environmentConfirmed = ref(false)
const staticCamera = ref(true)
const focalLength = ref('')
const busy = ref(false)
const statusMessage = ref('')
let nextVideoId = 1

const completedCount = computed(() => videos.value.filter((item) => item.status === 'done').length)
const errorCount = computed(() => videos.value.filter((item) => item.status === 'error').length)
const queuedCount = computed(() => videos.value.filter((item) => item.status !== 'done').length)
const aggregateProgress = computed(() => {
  if (!videos.value.length) return 0
  return videos.value.reduce((total, item) => total + item.progress, 0) / videos.value.length
})
const canRun = computed(() => (
  !busy.value
  && queuedCount.value > 0
  && runtime.value?.ready === true
  && environmentConfirmed.value
))

function text(en: string, zh: string): string {
  return props.locale === 'zh-CN' ? zh : en
}

function fileKey(file: UploadFile): string {
  return `${file._relpath || file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`
}

function isVideo(file: File): boolean {
  const suffix = file.name.toLowerCase().split('.').pop() || ''
  return VIDEO_SUFFIXES.has(suffix)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function statusLabel(status: VideoStatus): string {
  const labels: Record<VideoStatus, [string, string]> = {
    queued: ['Queued', '等待处理'],
    uploading: ['Uploading', '正在上传'],
    running: ['Generating motion', '正在生成动作'],
    done: ['Motion ready', '动作已生成'],
    error: ['Failed', '处理失败'],
  }
  return text(...labels[status])
}

async function waitForBridge(timeoutMs = 4_000): Promise<HhAppBridge> {
  const deadline = Date.now() + timeoutMs
  while (!window.__hhApp && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }
  if (!window.__hhApp) throw new Error(text('The application runtime is not ready.', '应用运行环境尚未就绪。'))
  return window.__hhApp
}

function addFiles(files: UploadFile[]): void {
  const existing = new Set(videos.value.map((item) => fileKey(item.file)))
  let rejected = 0
  for (const file of files) {
    if (!isVideo(file)) {
      rejected += 1
      continue
    }
    const key = fileKey(file)
    if (existing.has(key)) continue
    existing.add(key)
    videos.value.push({
      id: `v2m-${nextVideoId++}`,
      file,
      progress: 0,
      status: 'queued',
      message: '',
    })
  }
  if (rejected) {
    window.__hhApp?.toast(text(
      `${rejected} unsupported file(s) were skipped.`,
      `已跳过 ${rejected} 个不支持的文件。`,
    ), true)
  }
}

async function pickVideos(folder = false): Promise<void> {
  try {
    const bridge = await waitForBridge()
    addFiles(await bridge.pickFiles({ folder, accept: folder ? '' : VIDEO_ACCEPT }))
  } catch (error) {
    window.__hhApp?.toast(error instanceof Error ? error.message : String(error), true)
  }
}

async function dropVideos(event: DragEvent): Promise<void> {
  event.preventDefault()
  if (busy.value) return
  try {
    const bridge = await waitForBridge()
    addFiles(await bridge.collectDroppedFiles(event.dataTransfer))
  } catch (error) {
    window.__hhApp?.toast(error instanceof Error ? error.message : String(error), true)
  }
}

function removeVideo(id: string): void {
  if (busy.value) return
  videos.value = videos.value.filter((item) => item.id !== id)
}

function clearVideos(): void {
  if (busy.value) return
  videos.value = []
  statusMessage.value = ''
}

async function refreshRuntime(): Promise<void> {
  runtimeChecking.value = true
  runtimeError.value = ''
  environmentConfirmed.value = false
  try {
    const bridge = await waitForBridge()
    runtime.value = await bridge.API.get('/api/video-to-motion/status')
  } catch (error) {
    runtime.value = null
    runtimeError.value = error instanceof Error ? error.message : String(error)
  } finally {
    runtimeChecking.value = false
  }
}

function runtimeMessage(): string {
  if (runtimeChecking.value) return text('Checking GVHMR…', '正在检查 GVHMR……')
  if (runtime.value?.ready) return text('GVHMR official runtime is ready.', 'GVHMR 官方运行环境已就绪。')
  if (runtime.value?.missing?.length) return runtime.value.missing[0]
  return runtimeError.value || text('GVHMR runtime is unavailable.', 'GVHMR 运行环境不可用。')
}

function confirmEnvironment(): void {
  if (!runtime.value?.ready) return
  environmentConfirmed.value = true
}

function parsedFocalLength(): number | undefined {
  const raw = focalLength.value.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(text('Focal length must be a positive integer.', '焦距必须是正整数。'))
  }
  return value
}

async function runBatch(): Promise<void> {
  if (!canRun.value) return
  let fMm: number | undefined
  try {
    fMm = parsedFocalLength()
  } catch (error) {
    window.__hhApp?.toast(error instanceof Error ? error.message : String(error), true)
    return
  }

  const bridge = await waitForBridge()
  const pending = videos.value.filter((item) => item.status !== 'done')
  const generatedEntries: LibraryEntry[] = []
  busy.value = true
  statusMessage.value = text(`Processing ${pending.length} video(s)…`, `正在处理 ${pending.length} 个视频……`)

  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]
    item.status = 'uploading'
    item.progress = 0
    item.message = text('Uploading video…', '正在上传视频……')
    try {
      const started = await bridge.uploadFilesXHR(
        '/api/video-to-motion/upload',
        [item.file],
        { staticCam: staticCamera.value, fMm },
        (fraction) => {
          item.progress = (fraction ?? 0) * 0.08
          item.message = text('Uploading video…', '正在上传视频……')
        },
      )
      item.status = 'running'
      const payload = await bridge.waitMotionJob<MotionPayload>(
        started.job_id,
        (fraction, message) => {
          item.progress = fraction
          item.message = message
        },
        { uploadFrac: 0.08 },
      )
      item.status = 'done'
      item.progress = 1
      item.message = payload.name
      item.result = payload.library_entry
      if (payload.library_entry) generatedEntries.push(payload.library_entry)
    } catch (error) {
      item.status = 'error'
      item.message = error instanceof Error ? error.message : String(error)
    }
    statusMessage.value = text(
      `Processed ${index + 1} of ${pending.length}.`,
      `已处理 ${index + 1}/${pending.length}。`,
    )
  }

  if (generatedEntries.length) {
    bridge.addToBasket(generatedEntries, { silent: true })
    try {
      await bridge.refreshLibrary()
    } catch (error) {
      bridge.toast(text(
        `Motions were generated, but the library could not refresh: ${error instanceof Error ? error.message : String(error)}`,
        `动作已经生成，但动作库刷新失败：${error instanceof Error ? error.message : String(error)}`,
      ), true)
    }
  }
  busy.value = false
  statusMessage.value = errorCount.value
    ? text(
        `${completedCount.value} completed, ${errorCount.value} failed.`,
        `已完成 ${completedCount.value} 个，失败 ${errorCount.value} 个。`,
      )
    : text(
        `${completedCount.value} motion(s) generated and added to the H2R batch.`,
        `已生成 ${completedCount.value} 个动作，并加入 H2R 批量清单。`,
      )
  bridge.toast(statusMessage.value, errorCount.value > 0)
}

watch(() => props.active, (active) => {
  if (active && !runtime.value && !runtimeChecking.value) void refreshRuntime()
}, { immediate: true })
</script>

<template>
  <Teleport defer to="#stage">
    <section
      v-show="active"
      class="batch-stage-workspace v2m-batch-stage-workspace"
      :aria-label="text('Video inputs', '视频输入')"
    >
      <header class="batch-stage-header">
        <div>
          <h1>{{ text('Video inputs', '视频输入') }}</h1>
          <p>{{ text('Each video becomes an independent GVHMR task.', '每个视频会作为一项独立的 GVHMR 任务处理。') }}</p>
        </div>
        <div class="batch-stage-count" aria-live="polite">
          <strong>{{ videos.length }}</strong>
          <span>{{ text('videos', '个视频') }}</span>
        </div>
      </header>

      <div class="batch-stage-toolbar v2m-batch-stage-toolbar">
        <button type="button" class="btn" :disabled="busy" @click="pickVideos(false)">
          {{ text('Import videos', '导入视频') }}
        </button>
        <button type="button" class="btn secondary" :disabled="busy" @click="pickVideos(true)">
          {{ text('Import folder', '导入文件夹') }}
        </button>
      </div>

      <div
        class="batch-basket-frame v2m-batch-frame"
        :class="{ 'is-locked': busy }"
        @dragenter.prevent
        @dragover.prevent
        @drop="dropVideos"
      >
        <div class="v2m-batch-columns" aria-hidden="true">
          <span>{{ text('Video', '视频') }}</span>
          <span>{{ text('Size', '大小') }}</span>
          <span>{{ text('Status', '状态') }}</span>
          <span>{{ text('Actions', '操作') }}</span>
        </div>
        <div class="batch-basket-list" aria-live="polite">
          <div v-if="!videos.length" class="batch-basket-empty">
            <div>
              <strong>{{ text('Add videos to begin', '添加视频以开始') }}</strong>
              <span>{{ text('Supports MP4, MOV, MKV, AVI, WebM and M4V.', '支持 MP4、MOV、MKV、AVI、WebM 和 M4V。') }}</span>
            </div>
          </div>
          <div v-for="item in videos" :key="item.id" class="v2m-batch-row">
            <div class="batch-basket-main">
              <strong class="batch-basket-name">{{ item.file.name }}</strong>
              <small class="batch-basket-meta">{{ item.file._relpath || item.file.webkitRelativePath || item.file.name }}</small>
            </div>
            <span class="batch-basket-reference">{{ formatBytes(item.file.size) }}</span>
            <div class="v2m-batch-status">
              <span :class="['v2m-batch-state', `is-${item.status}`]">{{ statusLabel(item.status) }}</span>
              <small v-if="item.message">{{ item.message }}</small>
              <div v-if="item.progress > 0 && item.progress < 1" class="progress"><div class="bar" :style="{ width: `${Math.round(item.progress * 100)}%` }"></div></div>
            </div>
            <div class="batch-basket-actions">
              <button
                type="button"
                class="batch-basket-remove"
                :aria-label="text(`Remove ${item.file.name}`, `移除 ${item.file.name}`)"
                :disabled="busy"
                @click="removeVideo(item.id)"
              >×</button>
            </div>
          </div>
        </div>
      </div>

      <footer class="batch-stage-footer">
        <span class="batch-selected-count">
          {{ text(`${completedCount} ready · ${errorCount} failed`, `已完成 ${completedCount} 个 · 失败 ${errorCount} 个`) }}
        </span>
        <span class="spacer"></span>
        <button type="button" class="btn secondary small" :disabled="busy || !videos.length" @click="clearVideos">
          {{ text('Clear all', '清空全部') }}
        </button>
      </footer>
    </section>
  </Teleport>

  <div v-show="active" class="batch-mode-content v2m-batch-mode-content">
    <div class="batch-step-summary">
      <span>{{ text('1. Videos', '1. 视频') }}</span>
      <strong>{{ videos.length }} {{ text('videos', '个') }}</strong>
    </div>

    <details class="video-workflow-step" open>
      <summary class="video-workflow-step-summary">
        <span>{{ text('2. Environment', '2. 运行环境') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <label class="video-workflow-field">
          <span class="k">{{ text('Runtime', '推理环境') }}</span>
          <select class="search" disabled>
            <option>GVHMR Official</option>
          </select>
        </label>
        <button
          type="button"
          class="btn workflow-load-button"
          :class="{ 'is-confirmed': environmentConfirmed }"
          :disabled="runtimeChecking || !runtime?.ready || environmentConfirmed"
          @click="confirmEnvironment"
        >
          {{ environmentConfirmed ? text('Confirmed', '已确认') : text('Confirm environment', '确认运行环境') }}
        </button>
        <p class="workflow-status-line" :class="{ error: !runtimeChecking && !runtime?.ready }" role="status">
          {{ runtimeMessage() }}
        </p>
        <button type="button" class="btn secondary small" :disabled="runtimeChecking || busy" @click="refreshRuntime">
          {{ text('Check again', '重新检查') }}
        </button>
      </div>
    </details>

    <details class="video-workflow-step" open>
      <summary class="video-workflow-step-summary">
        <span>{{ text('3. Generate motions', '3. 生成动作') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <label class="workflow-checkbox-row">
          <input v-model="staticCamera" type="checkbox" />
          <span>{{ text('Static camera', '静态相机') }}</span>
        </label>
        <label class="video-workflow-field">
          <span class="k">{{ text('Focal length (optional, mm)', '焦距（可选，mm）') }}</span>
          <input v-model="focalLength" class="search" inputmode="numeric" placeholder="Auto" />
        </label>
        <button type="button" class="btn workflow-load-button" :disabled="!canRun" @click="runBatch">
          {{ busy ? text('Generating…', '生成中……') : text('Start V2M batch', '开始 V2M 批量任务') }}
        </button>
        <div v-if="busy || aggregateProgress > 0" class="progress video-workflow-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(aggregateProgress * 100)">
          <div class="bar" :style="{ width: `${Math.round(aggregateProgress * 100)}%` }"></div>
        </div>
        <p class="workflow-status-line" role="status" aria-live="polite">
          {{ statusMessage || text('Generated motions are added to the H2R batch automatically.', '生成的动作会自动加入 H2R 批量清单。') }}
        </p>
      </div>
    </details>

    <details class="video-workflow-step" open>
      <summary class="video-workflow-step-summary">
        <span>{{ text('4. Results', '4. 结果') }}</span>
      </summary>
      <div class="video-workflow-step-body workflow-compact-controls">
        <p class="workflow-status-line">
          {{ text(`${completedCount} motion(s) ready, ${errorCount} failed.`, `已生成 ${completedCount} 个动作，失败 ${errorCount} 个。`) }}
        </p>
      </div>
    </details>
  </div>
</template>
