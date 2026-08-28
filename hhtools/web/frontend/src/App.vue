<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { usePanelLayout } from './composables/usePanelLayout'
import PlaybackBar from './components/PlaybackBar.vue'
import CalibrationEditorControls from './components/CalibrationEditorControls.vue'
import CommandPalette from './components/CommandPalette.vue'
import DesktopMenuBar from './components/DesktopMenuBar.vue'
import JobDrawer from './components/JobDrawer.vue'
import ResultEvaluationPanel from './components/ResultEvaluationPanel.vue'
import SearchField from './components/SearchField.vue'
import SidebarNavigation from './components/SidebarNavigation.vue'
import VideoToMotionPipeline from './components/VideoToMotionPipeline.vue'
import WorkflowPipeline from './components/WorkflowPipeline.vue'
import WorkspaceDrawerHandle from './components/WorkspaceDrawerHandle.vue'
import WorkspaceSettingsDialog from './components/WorkspaceSettingsDialog.vue'
import type {
  ImportCommandTarget,
  JobAdmissionSettings,
  JobAdmissionSnapshot,
  MotionLibrarySettingsSnapshot,
  WorkspacePanelId,
  WorkspaceTheme,
} from './runtime/types'
import {
  loadWorkspacePreferences,
  updateWorkspacePreferences,
} from './runtime/workspace-preferences'

const isElectronHost = window.hhtoolsDesktop !== undefined
const panelLayout = usePanelLayout({ docked: true })
const initialWorkspacePreferences = loadWorkspacePreferences()
const activePanel = ref<WorkspacePanelId>(initialWorkspacePreferences.activePanel)
const workspaceLocale = ref(initialWorkspacePreferences.locale)
const workspaceTheme = ref<WorkspaceTheme>(initialWorkspacePreferences.theme)
const settingsOpen = ref(false)
const jobAdmission = ref<JobAdmissionSnapshot | null>(null)
const jobAdmissionLoading = ref(false)
const jobAdmissionSaving = ref(false)
const jobAdmissionError = ref<string | null>(null)
const jobAdmissionErrorOperation = ref<'load' | 'save' | null>(null)
const jobAdmissionSaved = ref(false)
const motionLibrarySettings = ref<MotionLibrarySettingsSnapshot | null>(null)
const motionLibrarySettingsLoading = ref(false)
const motionLibrarySettingsSaving = ref(false)
const motionLibrarySettingsError = ref<string | null>(null)
const motionLibrarySettingsSaved = ref(false)
const motionLibrarySearch = ref('')
type MotionUploadProfile = 'intermimic' | 'meshmimic' | 'mimic'
const motionUploadProfiles: ReadonlyArray<{ id: MotionUploadProfile; label: string }> = [
  { id: 'mimic', label: 'mimic' },
  { id: 'intermimic', label: 'intermimic' },
  { id: 'meshmimic', label: 'meshmimic' },
]
const motionUploadProfileMeta: Record<MotionUploadProfile, {
  glyph: string
  dropHintEn: string
  dropHintZh: string
}> = {
  mimic: {
    glyph: '🎞',
    dropHintEn: 'Drop a motion file or folder',
    dropHintZh: '拖入动作文件或文件夹',
  },
  intermimic: {
    glyph: '📦',
    dropHintEn: 'Drop a complete object-interaction motion folder',
    dropHintZh: '拖入完整的物体交互动作文件夹',
  },
  meshmimic: {
    glyph: '⛰',
    dropHintEn: 'Drop a complete terrain-motion folder',
    dropHintZh: '拖入完整的地形动作文件夹',
  },
}
const activeMotionUploadProfile = ref<MotionUploadProfile>('mimic')
const motionUploadInfoOpen = ref(false)

document.documentElement.lang = workspaceLocale.value
document.documentElement.dataset.theme = workspaceTheme.value

function workspaceText(en: string, zh: string): string {
  return workspaceLocale.value === 'en' ? en : zh
}

function setWorkspaceLocale(locale: typeof workspaceLocale.value): void {
  workspaceLocale.value = locale
  document.documentElement.lang = locale
  updateWorkspacePreferences({ locale })
  // Most workspace copy is rendered by Vue, while library rows are rendered
  // by the legacy runtime. Notify that runtime so both layers switch language
  // immediately without refreshing the library or restarting Electron.
  window.dispatchEvent(new Event('hhtools:workspace-locale-change'))
}

function setWorkspaceTheme(theme: WorkspaceTheme): void {
  workspaceTheme.value = theme
  document.documentElement.dataset.theme = theme
  updateWorkspacePreferences({ theme })
}

function toggleWorkspaceTheme(): void {
  setWorkspaceTheme(workspaceTheme.value === 'light' ? 'dark' : 'light')
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseJobAdmissionSnapshot(value: unknown): JobAdmissionSnapshot {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid job-admission response')
  }
  const candidate = value as Partial<JobAdmissionSnapshot>
  for (const key of [
    'max_running_jobs',
    'max_queued_jobs',
    'running_jobs',
    'queued_jobs',
    'reserved_jobs',
  ] as const) {
    if (!isNonNegativeInteger(candidate[key])) {
      throw new Error(`Invalid job-admission field: ${key}`)
    }
  }
  if (typeof candidate.editable !== 'boolean') {
    throw new Error('Invalid job-admission field: editable')
  }
  return candidate as JobAdmissionSnapshot
}

async function jobAdmissionHttpError(response: Response): Promise<Error> {
  let detail: unknown
  try {
    detail = (await response.json() as { detail?: unknown }).detail
  } catch {
    detail = null
  }
  if (typeof detail === 'string' && detail) return new Error(detail)
  if (detail && typeof detail === 'object' && 'msg' in detail) {
    return new Error(String((detail as { msg: unknown }).msg))
  }
  return new Error(`${response.status} ${response.statusText}`)
}

function parseMotionLibrarySettings(value: unknown): MotionLibrarySettingsSnapshot {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid motion-library settings response')
  }
  const candidate = value as Partial<MotionLibrarySettingsSnapshot>
  if (typeof candidate.root !== 'string' || !candidate.root) {
    throw new Error('Invalid motion-library settings field: root')
  }
  if (typeof candidate.default_root !== 'string' || !candidate.default_root) {
    throw new Error('Invalid motion-library settings field: default_root')
  }
  if (typeof candidate.editable !== 'boolean') {
    throw new Error('Invalid motion-library settings field: editable')
  }
  for (const key of ['readonly_reason', 'source'] as const) {
    if (candidate[key] !== undefined && candidate[key] !== null && typeof candidate[key] !== 'string') {
      throw new Error(`Invalid motion-library settings field: ${key}`)
    }
  }
  return candidate as MotionLibrarySettingsSnapshot
}

function motionLibraryReadOnlyMessage(settings: MotionLibrarySettingsSnapshot): string {
  const reason = settings.readonly_reason?.trim().toLowerCase()
  const source = settings.source?.trim().toLowerCase()
  if (
    reason === 'environment_override'
    || reason === 'environment'
    || source === 'environment_override'
    || source === 'environment'
  ) {
    return workspaceText(
      'The library directory is managed by HHTOOLS_MOTION_LIBRARY_ROOT. Change or remove that environment variable, then restart the service.',
      '资源库目录由 HHTOOLS_MOTION_LIBRARY_ROOT 管理。请修改或移除该环境变量，然后重启服务。',
    )
  }
  if (reason === 'remote' || reason === 'remote_client' || reason === 'non_loopback') {
    return workspaceText(
      'The library directory can only be changed on the server, in Electron, or through an SSH loopback tunnel.',
      '资源库目录只能从服务器本机、Electron 或 SSH 本地回环连接修改。',
    )
  }
  return workspaceText(
    'The server has made the library directory read-only. Check the server launch configuration or connection permissions.',
    '服务端已将资源库目录设为只读。请检查服务器启动配置或连接权限。',
  )
}

function motionLibraryRootButtonTitle(): string {
  const settings = motionLibrarySettings.value
  if (settings?.editable === false) return motionLibraryReadOnlyMessage(settings)
  return settings?.root || workspaceText(
    'Choose the library directory managed by hhtools',
    '选择 hhtools 管理的资源库目录',
  )
}

async function requestMotionLibrarySettings(
  method: 'GET' | 'PATCH',
  root?: string,
): Promise<MotionLibrarySettingsSnapshot> {
  const response = await fetch('/api/settings/motion-library', {
    method,
    headers: method === 'PATCH' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'PATCH' ? JSON.stringify({ root }) : undefined,
  })
  if (!response.ok) throw await jobAdmissionHttpError(response)
  return parseMotionLibrarySettings(await response.json())
}

async function requestJobAdmission(
  method: 'GET' | 'PATCH',
  settings?: JobAdmissionSettings,
): Promise<JobAdmissionSnapshot> {
  const response = await fetch('/api/settings/job-admission', {
    method,
    headers: method === 'PATCH' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'PATCH' ? JSON.stringify(settings) : undefined,
  })
  if (!response.ok) throw await jobAdmissionHttpError(response)
  return parseJobAdmissionSnapshot(await response.json())
}

async function loadJobAdmission(): Promise<void> {
  if (jobAdmissionLoading.value || jobAdmissionSaving.value) return
  jobAdmissionLoading.value = true
  jobAdmissionError.value = null
  jobAdmissionErrorOperation.value = null
  jobAdmissionSaved.value = false
  try {
    jobAdmission.value = await requestJobAdmission('GET')
  } catch (error) {
    jobAdmissionError.value = error instanceof Error ? error.message : String(error)
    jobAdmissionErrorOperation.value = 'load'
  } finally {
    jobAdmissionLoading.value = false
  }
}

async function saveJobAdmission(settings: JobAdmissionSettings): Promise<void> {
  // The dialog also disables its button, but this guard protects against fast
  // double clicks and programmatic duplicate events reaching the HTTP boundary.
  if (jobAdmissionSaving.value || jobAdmissionLoading.value) return
  jobAdmissionSaving.value = true
  jobAdmissionError.value = null
  jobAdmissionErrorOperation.value = null
  jobAdmissionSaved.value = false
  try {
    jobAdmission.value = await requestJobAdmission('PATCH', settings)
    jobAdmissionSaved.value = true
  } catch (error) {
    // Keep the last effective snapshot; the dialog owns its draft values, so a
    // failed save can be corrected and retried without losing either input.
    jobAdmissionError.value = error instanceof Error ? error.message : String(error)
    jobAdmissionErrorOperation.value = 'save'
  } finally {
    jobAdmissionSaving.value = false
  }
}

async function loadMotionLibrarySettings(): Promise<void> {
  if (motionLibrarySettingsLoading.value || motionLibrarySettingsSaving.value) return
  motionLibrarySettingsLoading.value = true
  motionLibrarySettingsError.value = null
  motionLibrarySettingsSaved.value = false
  try {
    motionLibrarySettings.value = await requestMotionLibrarySettings('GET')
  } catch (error) {
    motionLibrarySettingsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    motionLibrarySettingsLoading.value = false
  }
}

async function chooseMotionLibraryRoot(): Promise<void> {
  if (motionLibrarySettingsLoading.value || motionLibrarySettingsSaving.value) return
  motionLibrarySettingsError.value = null
  motionLibrarySettingsSaved.value = false
  try {
    if (!motionLibrarySettings.value) {
      motionLibrarySettingsLoading.value = true
      motionLibrarySettings.value = await requestMotionLibrarySettings('GET')
      motionLibrarySettingsLoading.value = false
    }
    if (motionLibrarySettings.value.editable !== true) {
      throw new Error(motionLibraryReadOnlyMessage(motionLibrarySettings.value))
    }

    // Electron can return a real host path. A normal browser cannot expose an
    // absolute directory path, so local Web mode deliberately asks for the
    // server-side path instead of pretending a webkitdirectory upload is one.
    const selected = window.hhtoolsDesktop?.selectDirectory
      ? await window.hhtoolsDesktop.selectDirectory()
      : window.prompt(
          workspaceText('Enter the library directory on the server', '输入服务器上的资源库目录'),
          motionLibrarySettings.value.root,
        )
    const root = selected?.trim()
    if (!root) return

    motionLibrarySettingsSaving.value = true
    motionLibrarySettings.value = await requestMotionLibrarySettings('PATCH', root)
    motionLibrarySettingsSaved.value = true
    await window.__hhApp?.refreshLibrary()
    window.__hhApp?.toast(workspaceText(
      `Library directory changed: ${motionLibrarySettings.value.root}`,
      `资源库目录已切换：${motionLibrarySettings.value.root}`,
    ))
  } catch (error) {
    motionLibrarySettingsError.value = error instanceof Error ? error.message : String(error)
    window.__hhApp?.toast(motionLibrarySettingsError.value, true)
  } finally {
    motionLibrarySettingsLoading.value = false
    motionLibrarySettingsSaving.value = false
  }
}

function openWorkspaceSettings(): void {
  settingsOpen.value = true
  void loadJobAdmission()
  void loadMotionLibrarySettings()
}

function setActivePanel(panel: string): void {
  // Keep the old runtime/tutorial panel id working while the workspace is split.
  activePanel.value = panel === 'robot' ? 'h2r' : panel as WorkspacePanelId
  updateWorkspacePreferences({ activePanel: activePanel.value })
}

function requestPanel(panel: string): void {
  window.dispatchEvent(new CustomEvent('hhtools:panel-request', { detail: panel }))
}

function showBoot(message: string): void {
  const element = document.getElementById('boot-error')
  if (!element) return
  element.style.display = 'block'
  element.textContent = `界面未能初始化：${message}（按 F12 查看 Console）`
}

const importTargets: Record<Exclude<ImportCommandTarget, 'job-spec'>, {
  panel: WorkspacePanelId
  selector: string
  motionProfile?: MotionUploadProfile
}> = {
  'motion-file': { panel: 'motion', selector: '#motion-pick-file', motionProfile: 'mimic' },
  'motion-folder': { panel: 'motion', selector: '#motion-pick-folder', motionProfile: 'mimic' },
  'video-file': { panel: 'video', selector: '#video-pick-file' },
  'robot-urdf': { panel: 'robot-assets', selector: '#robot-pick-urdf' },
  'robot-mesh-folder': { panel: 'robot-assets', selector: '#robot-pick-mesh-folder' },
  'robot-trajectory': { panel: 'r2r', selector: '[data-r2r-pick="mimic"]:not([data-folder])' },
  'dataset-folder': { panel: 'dataset-viz', selector: '#dv-pick-folder' },
}

function handleImportCommand(event: WindowEventMap['hhtools:import-command']): void {
  if (event.detail.target === 'job-spec') {
    window.dispatchEvent(new CustomEvent('hhtools:job-spec-import-request'))
    return
  }

  const target = importTargets[event.detail.target]
  if (target.motionProfile) selectMotionUploadProfile(target.motionProfile)
  requestPanel(target.panel)
  window.setTimeout(() => {
    const button = document.querySelector<HTMLButtonElement>(target.selector)
    if (button) button.click()
    else window.__hhApp?.toast('导入入口尚未准备完成，请稍后重试', true)
  }, 0)
}

function selectMotionUploadProfile(profile: MotionUploadProfile): void {
  activeMotionUploadProfile.value = profile
  motionUploadInfoOpen.value = false
}

function toggleMotionUploadInfo(): void {
  motionUploadInfoOpen.value = !motionUploadInfoOpen.value
}

function closeMotionUploadInfo(event: Event): void {
  const target = event.target
  // Keep the popover open while its trigger or content is being used; any
  // click elsewhere in the workspace dismisses it without adding a modal.
  if (target instanceof Element && target.closest('.motion-import-info')) return
  motionUploadInfoOpen.value = false
}

function handleMotionUploadInfoKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') motionUploadInfoOpen.value = false
}

onMounted(async () => {
  window.showBoot = showBoot
  window.__hhUi = { setActivePanel, requestPanel }
  window.addEventListener('hhtools:import-command', handleImportCommand)
  document.addEventListener('click', closeMotionUploadInfo)
  document.addEventListener('keydown', handleMotionUploadInfoKeydown)
  // Load capability metadata up front so the always-visible library control
  // cannot advertise a write action on a read-only server connection.
  void loadMotionLibrarySettings()

  try {
    // The renderer owns UI markup; the runtime modules own Three.js and long-running workflows.
    await import('./runtime/webui-runtime')
    await import('./runtime/dataset-viz')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showBoot(message)
    console.error('hhtools renderer failed to initialize', error)
  }

  window.setTimeout(() => {
    if (!window.__hhtoolsReady) showBoot('Vue renderer runtime did not finish initialization')
  }, 4_000)
})

onBeforeUnmount(() => {
  window.removeEventListener('hhtools:import-command', handleImportCommand)
  document.removeEventListener('click', closeMotionUploadInfo)
  document.removeEventListener('keydown', handleMotionUploadInfoKeydown)
  delete window.__hhUi
})
</script>

<template>
  <div
    id="app"
    :class="{
      'workspace-shell': true,
      'electron-host': isElectronHost,
      'web-host': !isElectronHost,
      'sidebar-hidden': panelLayout.state.sidebarHidden,
      'inspector-hidden': panelLayout.state.inspectorHidden
    }"
    :style="panelLayout.style.value"
  >
    <!-- top bar -->
    <header id="topbar">
      <div class="logo">
        <img class="desktop-logo-mark" src="/hhtools-robot.svg" alt="" />
        <span class="desktop-brand-name">HHTOOLS</span>
        <span v-show="false" class="ui-build" id="ui-build">UI·v25</span>
      </div>
      <DesktopMenuBar
        :active-panel="activePanel"
        :locale="workspaceLocale"
        :theme="workspaceTheme"
        @open-settings="openWorkspaceSettings"
        @toggle-theme="toggleWorkspaceTheme"
      />
      <div class="spacer"></div>
      <CommandPalette
        :active-panel="activePanel"
        :locale="workspaceLocale"
        :theme="workspaceTheme"
        application-mode
        @open-settings="openWorkspaceSettings"
        @toggle-theme="toggleWorkspaceTheme"
      />
      <span v-show="false" class="pill" id="motion-pill">未加载动作</span>
      <span v-show="false" class="pill" id="robot-pill">未加载机器人</span>
    </header>

    <!-- sidebar nav -->
    <nav
      id="sidebar"
      class="side-panel"
      :aria-label="workspaceText('Navigation', '导航')"
      :aria-hidden="panelLayout.state.sidebarHidden"
      :inert="panelLayout.state.sidebarHidden"
    >
      <div id="sidebar-body">
        <SidebarNavigation
          :active-panel="activePanel"
          workspace
          :locale="workspaceLocale"
          @request="requestPanel"
        />
      </div>
    </nav>
    <div class="col-resizer" id="resize-sidebar" title="拖动调节左栏宽度" @pointerdown="panelLayout.startResize('sidebar', $event)"></div>
    <WorkspaceDrawerHandle
      side="left"
      :expanded="!panelLayout.state.sidebarHidden"
      :locale="workspaceLocale"
      @toggle="panelLayout.setHidden('sidebar', !panelLayout.state.sidebarHidden)"
    />

    <!-- 3D stage -->
    <main id="stage">
      <canvas id="three-canvas"></canvas>
      <svg id="calib-mapping-overlay" class="calib-mapping-overlay" aria-hidden="true"></svg>
      <div id="calib-landmark-labels" class="calib-landmark-labels" aria-hidden="true"></div>
      <div id="calib-hud" class="calib-hud hidden" aria-hidden="true"></div>
      <div id="calib-hover-hint" class="calib-hover-hint" aria-hidden="true"></div>
      <div class="stage-top-tools">
        <div class="view-hud" id="view-hud">
          <div class="view-hud-row" data-row="motion">
            <button class="seg-btn" id="tg-skeleton" title="显示/隐藏原始动作骨架">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Skeleton', '骨架') }}</span>
            </button>
            <button class="seg-btn on" id="tg-mesh" title="显示/隐藏身体 mesh（SMPL 皮肤或管状近似）">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Body', '身体') }}</span>
            </button>
            <button class="seg-btn" id="tg-env" disabled title="显示/隐藏原始动作的地形与交互物体">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Objects/Terrain', '物体/地形') }}</span>
            </button>
          </div>
          <div class="view-hud-row" data-row="robot">
            <button class="seg-btn" id="tg-scaled" disabled title="按机器人标定缩放后、IK 之前的效应器骨架">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Scaled Skeleton', '缩放骨架') }}</span>
            </button>
            <button class="seg-btn" id="tg-scaled-env" disabled title="缩放后的地形与交互物体（与机器人同坐标系）">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Scaled Scene', '缩放场景') }}</span>
            </button>
            <button class="seg-btn" id="tg-robot" disabled title="显示/隐藏重定向后的机器人">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Robot', '机器人') }}</span>
            </button>
          </div>
        </div>
        <div class="view-hud hidden" id="view-hud-r2r">
          <div class="view-hud-row" data-row="r2r-src">
            <span class="view-hud-tag">{{ workspaceText('Source', '源') }}</span>
            <button class="seg-btn on" id="r2r-tg-src-robot" title="源机器人 mesh">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Robot', '机器人') }}</span>
            </button>
            <button class="seg-btn" id="r2r-tg-src-skel" disabled title="源关键点骨架（FK）">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Skeleton', '骨架') }}</span>
            </button>
            <button class="seg-btn" id="r2r-tg-src-env" disabled title="源轨迹附带的地形/物体">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Objects/Terrain', '物体/地形') }}</span>
            </button>
          </div>
          <div class="view-hud-row" data-row="r2r-tgt">
            <span class="view-hud-tag">{{ workspaceText('Target', '目标') }}</span>
            <button class="seg-btn" id="r2r-tg-tgt-robot" disabled title="目标机器人 mesh">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Robot', '机器人') }}</span>
            </button>
            <button class="seg-btn" id="r2r-tg-tgt-skel" disabled title="目标缩放骨架（IK 效应器）">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Skeleton', '骨架') }}</span>
            </button>
            <button class="seg-btn" id="r2r-tg-tgt-env" disabled title="目标缩放后的地形/物体">
              <span class="eye" aria-hidden="true">👁</span><span class="lbl">{{ workspaceText('Objects/Terrain', '物体/地形') }}</span>
            </button>
          </div>
        </div>
      </div>
      <div class="stage-empty" id="stage-empty">
        <div>
          <div class="glyph">🎞</div>
          <div class="big">{{ workspaceText('Drop a motion here to preview', '把动作拖到这里预览') }}</div>
          <div class="sub">{{ workspaceText(
            'Supports BVH / GLB / NPZ and datasets such as AMASS, Motion-X, OMOMO, and holosoma. Drop content on the stage, choose a file or folder from the Motion panel, or select a clip from the Library.',
            '支持 BVH / GLB / NPZ 以及 AMASS、Motion-X、OMOMO、holosoma 等数据集。可拖到此舞台、在右侧「动作」面板选择文件或文件夹，或直接从资源库点选。',
          ) }}</div>
        </div>
      </div>
      <div class="stage-overlay">
        <button
          type="button"
          class="view-reset-btn hidden"
          id="view-reset-btn"
          :title="workspaceText('Reset view', '回到默认视角')"
          :aria-label="workspaceText('Reset view', '回到默认视角')"
        >
          <svg class="view-reset-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3.25"/>
            <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21"/>
          </svg>
        </button>
        <PlaybackBar />
      </div>
    </main>
    <div
      class="col-resizer"
      id="resize-inspector"
      :title="workspaceText('Drag to resize the inspector', '拖动调节右栏宽度')"
      @pointerdown="panelLayout.startResize('inspector', $event)"
    ></div>

    <!-- right inspector -->
    <aside
      id="inspector"
      class="side-panel"
      :aria-label="workspaceText('Inspector', '控制面板')"
      :aria-hidden="panelLayout.state.inspectorHidden"
      :inert="panelLayout.state.inspectorHidden"
    >
      <div id="inspector-body">
      <!-- MOTION -->
      <section class="panel" :class="{ active: activePanel === 'motion' }" data-panel="motion">
        <h2>{{ workspaceText('Motion', '动作') }}</h2>

        <div class="motion-import-control" id="tour-motion-import">
          <!-- Native radios keep the compact profile switcher keyboard-friendly.
               The selected profile drives one shared dropzone and both pickers. -->
          <div
            class="motion-profile-switcher"
            role="radiogroup"
            :aria-label="workspaceText('Motion import type', '动作上传类型')"
          >
            <label
              v-for="profile in motionUploadProfiles"
              :key="profile.id"
              class="motion-profile-selector"
            >
              <input
                class="sr-only"
                type="radio"
                name="motion-upload-profile"
                :value="profile.id"
                :checked="activeMotionUploadProfile === profile.id"
                @change="selectMotionUploadProfile(profile.id)"
              />
              <span class="motion-profile-selector-content">{{ profile.label }}</span>
            </label>
          </div>

          <div
            class="dropzone motion-upload-shared"
            id="motion-drop-shared"
            :data-profile="activeMotionUploadProfile"
            role="group"
            :aria-label="workspaceText(
              `${activeMotionUploadProfile} import area`,
              `${activeMotionUploadProfile} 上传区`,
            )"
          >
            <div class="motion-import-info">
              <button
                type="button"
                class="motion-import-info-trigger"
                :aria-label="workspaceText(
                  `View ${activeMotionUploadProfile} import instructions`,
                  `查看 ${activeMotionUploadProfile} 上传说明`,
                )"
                aria-controls="motion-upload-info"
                :aria-expanded="motionUploadInfoOpen"
                :aria-describedby="motionUploadInfoOpen ? 'motion-upload-info' : undefined"
                @click.stop="toggleMotionUploadInfo"
              >?</button>
              <div
                v-show="motionUploadInfoOpen"
                id="motion-upload-info"
                class="motion-import-info-popover"
                role="tooltip"
                @click.stop
              >
                <template v-if="activeMotionUploadProfile === 'intermimic'">
                  <strong>{{ workspaceText('Object-interaction motion · OMOMO', '物体交互动作 · OMOMO') }}</strong>
                  <span>
                    {{ workspaceText('Choose a complete clip folder or an entire dataset directory. Requires ', '请选择完整 clip 文件夹或整个数据集目录。需要 ') }}
                    <code>&lt;clip&gt;/&lt;clip&gt;.pkl</code>{{ workspaceText('; interaction objects are usually ', '，交互物体通常为 ') }}<code>*_cleaned_simplified.obj</code>{{ workspaceText('.', '。') }}
                  </span>
                </template>
                <template v-else-if="activeMotionUploadProfile === 'meshmimic'">
                  <strong>{{ workspaceText('Terrain motion · parc_ms', '地形动作 · parc_ms') }}</strong>
                  <span>
                    {{ workspaceText('Choose a complete clip folder or an entire dataset directory. Requires ', '请选择完整 clip 文件夹或整个数据集目录。需要 ') }}
                    <code>&lt;clip&gt;/&lt;clip&gt;.pkl</code>{{ workspaceText(' or ', ' 或 ') }}<code>.npz</code>{{ workspaceText('; terrain meshes are usually ', '，地形通常为 ') }}<code>*_terrain.obj</code>{{ workspaceText('.', '。') }}
                  </span>
                </template>
                <template v-else>
                  <strong>{{ workspaceText('General human motion', '通用人体动作') }}</strong>
                  <span>
                    {{ workspaceText('Supports a single file or a nested dataset folder. Recognized formats: ', '支持单个文件或多级数据集文件夹。可识别 ') }}
                    <code>.bvh</code>, <code>.glb</code>, <code>.gltf</code>, <code>.npz</code>, <code>.npy</code>, <code>.pkl</code>, <code>.pt</code>{{ workspaceText('.', '。') }}
                  </span>
                </template>
              </div>
            </div>
            <div class="dz-glyph">{{ motionUploadProfileMeta[activeMotionUploadProfile].glyph }}</div>
            <div class="dz-title">{{ workspaceText(
              motionUploadProfileMeta[activeMotionUploadProfile].dropHintEn,
              motionUploadProfileMeta[activeMotionUploadProfile].dropHintZh,
            ) }}</div>
            <div class="row" style="margin-top:10px">
              <button
                v-show="activeMotionUploadProfile === 'mimic'"
                id="motion-pick-file"
                type="button"
                class="btn secondary small"
                :data-pick="activeMotionUploadProfile"
                data-accept=".bvh,.glb,.gltf,.npz,.npy,.pkl,.pt"
              >{{ workspaceText('Choose file', '选择文件') }}</button>
              <button
                id="motion-pick-folder"
                type="button"
                class="btn secondary small"
                :data-pick="activeMotionUploadProfile"
                data-folder="1"
              >{{ workspaceText('Choose folder', '选择文件夹') }}</button>
            </div>
          </div>
        </div>

        <!-- The library is a peer workspace, not another card nested under
             Motion. Only its scrollable result list owns a visual frame. -->
        <section class="motion-library" id="tour-motion-library" aria-labelledby="motion-library-title">
          <h2 id="motion-library-title">{{ workspaceText('Library', '资源库') }}</h2>

          <div class="motion-library-root-row">
            <button
              type="button"
              class="btn secondary small motion-library-root-button"
              :disabled="motionLibrarySettingsLoading || motionLibrarySettingsSaving || motionLibrarySettings?.editable === false"
              :title="motionLibraryRootButtonTitle()"
              @click="chooseMotionLibraryRoot"
            >{{ motionLibrarySettingsSaving
              ? workspaceText('Switching…', '正在切换…')
              : workspaceText('Choose library directory', '选择资源库目录') }}</button>
            <div class="motion-library-category-select-wrap">
              <select
                class="search motion-library-category-select"
                id="lib-category"
                :aria-label="workspaceText('Filter the library by motion type', '按动作类型筛选资源库')"
              >
                <option value="all">{{ workspaceText('All', '全部') }}</option>
                <option value="motion">{{ workspaceText('Motion', '纯动作') }}</option>
                <option value="object">{{ workspaceText('Object interaction', '物体交互') }}</option>
                <option value="terrain">{{ workspaceText('Terrain scene', '地形场景') }}</option>
              </select>
              <!-- Heroicons "chevron-down" outline path, MIT licensed. -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>

          <div class="motion-library-tools">
            <SearchField
              v-model="motionLibrarySearch"
              id="lib-search"
              :label="workspaceText('Search the Motion Library', '搜索资源库动作')"
              :placeholder="workspaceText('Search motions…', '搜索动作……')"
              :clear-label="workspaceText('Clear library search', '清除资源库搜索')"
            />
            <button
              type="button"
              class="btn secondary small"
              id="lib-link-path"
              :title="workspaceText('Link an external server directory to the current library', '把服务器上的外部数据集链接到当前资源库')"
            >{{ workspaceText('Link directory', '链接目录') }}</button>
          </div>
          <div class="motion-library-list-frame">
            <div class="lib-list" id="lib-list"></div>
          </div>
        </section>

        <div class="card" id="motion-meta-card" style="display:none">
          <h3 id="motion-name">—</h3>
          <div id="motion-meta"></div>
          <div class="validation-summary" id="motion-validation-summary" aria-live="polite"></div>
          <div class="divider"></div>
          <button class="btn secondary small" id="add-to-basket">
            {{ workspaceText('＋ Add to batch basket', '＋ 加入批量篮子') }}
          </button>
        </div>
      </section>

      <!-- VIDEO -->
      <section class="panel" :class="{ active: activePanel === 'video' }" data-panel="video">
        <h2>{{ workspaceText('Video', '视频') }}</h2>
        <p class="lead">
          {{ workspaceText(
            'Select and preview one local source video. The file is uploaded only when you start Video → Motion.',
            '选择并预览一个本地源视频。只有在启动“视频 → 动作”后才会上传。',
          ) }}
        </p>

        <div class="motion-import-control">
          <div
            class="dropzone motion-upload-shared video-upload-shared"
            id="video-drop-shared"
            role="group"
            :aria-label="workspaceText('Video import area', '视频上传区')"
          >
            <div class="dz-glyph">🎥</div>
            <div class="dz-title">{{ workspaceText('Drop a video file here', '拖入一个视频文件') }}</div>
            <div class="dz-sub">MP4, MOV, MKV, AVI, WebM, M4V</div>
            <div class="row" style="margin-top:10px">
              <button id="video-pick-file" type="button" class="btn secondary small">
                {{ workspaceText('Choose video', '选择视频') }}
              </button>
            </div>
          </div>
        </div>

        <p id="gvhmr-runtime-status" class="hint video-runtime-status" role="status">
          {{ workspaceText('Checking the GVHMR runtime…', '正在检查 GVHMR 推理环境……') }}
        </p>

        <section id="gvhmr-video-selection" class="video-selection" style="display:none">
          <video id="gvhmr-video-preview" controls preload="metadata"></video>
          <div class="video-selection-copy">
            <strong id="gvhmr-video-name">—</strong>
            <span id="gvhmr-video-meta" class="hint"></span>
          </div>
          <button type="button" class="btn" @click="requestPanel('video-to-motion')">
            {{ workspaceText('Continue to Video → Motion', '继续到视频 → 动作') }}
          </button>
        </section>
      </section>

      <!-- VIDEO TO MOTION -->
      <section
        class="panel"
        :class="{ active: activePanel === 'video-to-motion' }"
        data-panel="video-to-motion"
      >
        <div class="panel-stack">
          <h2>{{ workspaceText('Video → Motion', '视频 → 动作') }}</h2>
          <p class="lead">
            {{ workspaceText(
              'Recover a reusable human motion from one video with the official GVHMR checkpoint or a compatible custom checkpoint.',
              '使用 GVHMR 官方权重或兼容的自定义权重，从单个视频中恢复可复用的人体动作。',
            ) }}
          </p>
          <VideoToMotionPipeline :locale="workspaceLocale" />

          <div class="card">
            <h3>{{ workspaceText('1 · Status', '1 · 状态') }}</h3>
            <div class="meta-row">
              <span class="k">{{ workspaceText('Video', '视频') }}</span>
              <span class="v" id="gvhmr-workflow-video">{{ workspaceText('Not selected', '未选择') }}</span>
            </div>
            <div class="meta-row">
              <span class="k">GVHMR</span>
              <span class="v" id="gvhmr-workflow-runtime">{{ workspaceText('Checking…', '检查中……') }}</span>
            </div>
            <div class="meta-row">
              <span class="k">{{ workspaceText('Model weights', '模型权重') }}</span>
              <span class="v" id="gvhmr-workflow-checkpoint">
                {{ workspaceText('Official GVHMR (default)', 'GVHMR 官方权重（默认）') }}
              </span>
            </div>
            <button type="button" class="btn secondary small" @click="requestPanel('video')">
              {{ workspaceText('Choose or replace video', '选择或替换视频') }}
            </button>
          </div>

          <div class="card">
            <h3>{{ workspaceText('2 · Generate motion', '2 · 生成动作') }}</h3>
            <label class="video-workflow-field">
              <span class="k">{{ workspaceText('Model weights', '模型权重') }}</span>
              <select id="gvhmr-weight-source" class="search">
                <option value="official">
                  {{ workspaceText('Official GVHMR (default)', 'GVHMR 官方权重（默认）') }}
                </option>
                <option value="custom">
                  {{ workspaceText('Custom compatible checkpoint', '自定义兼容权重') }}
                </option>
              </select>
            </label>
            <div id="gvhmr-custom-checkpoint" class="video-checkpoint-control" style="display:none">
              <button id="gvhmr-pick-checkpoint" type="button" class="btn secondary small">
                {{ workspaceText('Import checkpoint', '导入权重') }}
              </button>
              <span id="gvhmr-checkpoint-name" class="video-checkpoint-name">
                {{ workspaceText('No checkpoint selected', '尚未选择权重') }}
              </span>
            </div>
            <p class="hint video-checkpoint-hint">
              {{ workspaceText(
                'Custom CKPT, PT, or PTH files must match the GVHMR architecture. Only import checkpoints you trust.',
                '自定义 CKPT、PT 或 PTH 文件必须兼容 GVHMR 架构，并且只应导入可信权重。',
              ) }}
            </p>
            <label class="row video-workflow-option">
              <input id="gvhmr-static-cam" type="checkbox" checked />
              <span>
                <b>{{ workspaceText('Static camera', '静态相机') }}</b>
                <small>{{ workspaceText('Use when the recording camera does not move.', '录制相机没有移动时启用。') }}</small>
              </span>
            </label>
            <label class="video-workflow-field">
              <span class="k">{{ workspaceText('Focal length (optional, mm)', '焦距（可选，mm）') }}</span>
              <input
                id="gvhmr-f-mm"
                class="search"
                type="number"
                min="1"
                step="1"
                :placeholder="workspaceText('Auto estimate', '自动估计')"
              />
            </label>
            <button id="gvhmr-run" type="button" class="btn" disabled>
              {{ workspaceText('Start GVHMR', '开始 GVHMR 推理') }}
            </button>
            <p id="gvhmr-disabled-reason" class="disabled-action-reason" role="status">
              {{ workspaceText('Select a video first.', '请先选择视频。') }}
            </p>
            <div id="gvhmr-progress" class="progress video-workflow-progress" style="display:none">
              <div class="bar"></div>
            </div>
            <p id="gvhmr-status" class="hint" role="status"></p>
          </div>

          <div id="gvhmr-result-card" class="card" style="display:none">
            <h3>{{ workspaceText('3 · Result', '3 · 结果') }}</h3>
            <div class="meta-row"><span class="k">{{ workspaceText('Motion', '动作') }}</span><span class="v" id="gvhmr-result-name">—</span></div>
            <div class="meta-row"><span class="k">{{ workspaceText('Frames', '帧数') }}</span><span class="v" id="gvhmr-result-frames">—</span></div>
            <div class="meta-row"><span class="k">{{ workspaceText('Duration', '时长') }}</span><span class="v" id="gvhmr-result-duration">—</span></div>
            <p class="hint">
              {{ workspaceText(
                'The generated clip is loaded into the 3D stage and published to the Motion Library.',
                '生成结果已加载到 3D 舞台，并发布到 Motion Library。',
              ) }}
            </p>
            <button type="button" class="btn secondary" @click="requestPanel('motion')">
              {{ workspaceText('Open Motion Library', '打开动作资源库') }}
            </button>
          </div>
        </div>
      </section>

      <!-- Robot assets and the H2R workflow share runtime state but have separate workspaces. -->
      <section
        class="panel"
        :class="{ active: activePanel === 'robot-assets' || activePanel === 'h2r' }"
        data-panel="robot"
      >
        <div v-show="activePanel === 'robot-assets'" class="panel-stack">
          <h2>机器人 Robot Registry</h2>
          <p class="lead">注册或检查可复用的 Robot Model：URDF 描述、mesh 资源、DoF、<code>ik_map</code> 与标定配置。</p>

          <div class="robot-import-grid" id="tour-robot-import">
          <div class="dropzone dropzone-compact" id="robot-drop-urdf">
            <div class="dz-glyph">📄</div>
            <div class="dz-title">1 · URDF 文件</div>
            <div class="dz-sub">拖入 <code>*.urdf</code>，或选择机器人描述文件</div>
            <div class="row" style="margin-top:10px">
              <button class="btn secondary small" id="robot-pick-urdf">选择 .urdf</button>
            </div>
          </div>
          <div class="dropzone dropzone-compact" id="robot-drop-mesh">
            <div class="dz-glyph">📁</div>
            <div class="dz-title">2 · Mesh 文件夹</div>
            <div class="dz-sub">拖入 <code>meshes/</code> 目录或 <code>.stl/.obj/.dae</code> 网格</div>
            <div class="row" style="margin-top:10px">
              <button class="btn secondary small" id="robot-pick-mesh-folder">选择 mesh 文件夹</button>
            </div>
          </div>
          </div>
          <p class="hint" id="robot-import-status" style="margin-top:8px">尚未选择 URDF。</p>

          <div class="card">
            <h3>已注册机器人</h3>
            <select class="search" id="robot-select"></select>
            <p class="hint" id="robot-library-hint" style="margin-top:6px">通过 UI 注册的机器人保存在用户资源库，重启 <code>hhtools web</code> 后仍可用。</p>
            <div class="row" style="margin-top:8px;gap:8px">
              <button class="btn secondary small" id="robot-load-btn" style="flex:1">加载选中机器人</button>
              <button class="btn secondary small" id="robot-delete-btn" style="display:none" title="从用户资源库删除（内置机器人不可删）">删除</button>
            </div>
          </div>

          <div class="card" id="robot-meta-card" style="display:none">
            <h3 id="robot-name">—</h3>
            <div id="robot-meta"></div>
            <div class="validation-summary" id="robot-validation-summary" aria-live="polite"></div>
          </div>
        </div>

        <div v-show="activePanel === 'h2r'" class="panel-stack">
          <h2>人体 → 机器人 H2R</h2>
          <p class="lead">输入人体 Motion 与目标 Robot Model，匹配标定配置后运行 IK/MPC，输出可播放、可导出的 Robot Trajectory。</p>
          <WorkflowPipeline workflow="h2r" />

          <div class="card" id="tour-calibration">
          <h3>1 · 状态</h3>
          <div class="meta-row"><span class="k">动作</span><span class="v" id="rt-motion">未加载</span></div>
          <div class="meta-row"><span class="k">机器人</span><span class="v" id="rt-robot">未加载</span></div>
          <div class="meta-row meta-row-select">
            <span class="k">参考姿态</span>
            <select class="search" id="rt-ref-select" disabled title="标定用人体参考骨架；自动识别有误时可手动切换">
              <option value="">—</option>
            </select>
          </div>
          <p class="hint" id="rt-ref-hint" style="display:none;margin-top:2px"></p>
          <div class="meta-row"><span class="k">标定</span><span class="v" id="rt-cal"><span class="status-chip"><span class="dot"></span>—</span></span></div>
          <div style="height:8px"></div>
          <button class="btn secondary small" id="recalib-btn" disabled>重新标定</button>
          <div class="calibration-save-summary" id="calibration-save-summary" aria-live="polite"></div>
          </div>

          <div class="card" id="calib-card" style="display:none">
            <h3>2 · 参考姿态对齐 Calibration</h3>
            <div class="calibration-principle">
              调整目标机器人，使其静止姿态与蓝色源参考骨架在语义上对应。机器人比例不同，<b>不要求逐点重合</b>；hhtools 会根据 FK 推导缩放与姿态偏移。
            </div>
            <div class="calibration-scope" id="calibration-scope">配置范围：目标机器人 + 源参考格式</div>
            <div class="validation-summary" id="calibration-validation-summary" aria-live="polite"></div>
            <p class="hint">舞台只显示<b>灰色机器人</b>与<b>蓝色参考骨架</b>。蓝色骨架是当前参考格式的标准姿态，不是正在播放的 Motion，也不一定是 URDF 零位。可在 3D 中点击关节拖动，或用下方滑块微调。</p>
          <CalibrationEditorControls workflow="h2r" />
          <div id="calib-sliders" class="calibration-joint-list"></div>
          <div class="divider"></div>
          <div class="row">
            <button class="btn secondary small" id="calib-zero" title="全部关节置 0（URDF 零位）">归零</button>
            <button class="btn secondary small" id="calib-restore" disabled
              title="恢复到上次保存的标定值">重置</button>
            <button class="btn secondary small" id="calib-cancel">取消</button>
            <button class="btn small" id="calib-save">保存标定</button>
          </div>
          </div>

          <div class="card" id="tour-retarget">
          <h3>3 · 执行</h3>
          <div class="row">
            <select class="search" id="rt-backend">
              <option value="newton">Newton IK（骨架）</option>
              <option value="interaction_mesh">Interaction-Mesh（含物体/地形）</option>
            </select>
          </div>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap" title="求解前对人体动作抽帧">Retarget FPS</label>
            <input class="search" id="rt-retarget-fps" type="number" min="1" step="1" style="flex:1"
              placeholder="留空 = 动作原始帧率" />
          </div>
          <p class="hint" id="rt-retarget-fps-hint" style="margin-top:4px">
            <b>Retarget FPS</b>：在跑 IK/MPC <b>之前</b>对人体动作（含物体轨迹）重采样；帧数变少会<b>更快</b>，但可能丢失快动作/接触细节。留空则用原始帧率。
          </p>
          <p class="hint" id="rt-first-hint" style="margin-top:6px">
            <b>首次 Retarget 较慢：</b>新机器人第一次求解会编译 GPU/Warp IK 内核并捕获 CUDA 图（约 10–60 秒）。进度条可能短暂不动，属正常现象，请耐心等待；加载机器人后会在后台预热，同一机器人后续会快很多。
          </p>
          <p class="hint" id="rt-tuning-hint" style="margin-top:6px">
            默认机器人构型比例接近 SMPL。若手臂、肩宽或腿宽与预期不符，可手动编辑 <code>~/.config/hhtools/robots/&lt;name&gt;/robot.yaml</code> 中的 scale（<code>retarget.joint_scale_multipliers</code>）与权重（<code>weights</code>）针对自己的机器人微调；改 yaml 后下次 Retarget 即生效。
          </p>
          <div style="height:8px"></div>
          <button class="btn" id="retarget-btn" disabled>开始 Retarget</button>
          <p class="disabled-action-reason" id="retarget-disabled-reason" role="status">请先加载动作与机器人。</p>
          <div style="height:10px"></div>
          <div class="progress" style="display:none" id="rt-progress"><div class="bar"></div></div>
          <div class="hint" id="rt-status" style="margin-top:8px"></div>
          </div>

          <ResultEvaluationPanel workflow="h2r" />

          <div class="card" id="rt-export-card" style="display:none">
          <h3>4 · 导出</h3>
          <p class="hint" id="rt-export-fmt">格式：<code>time, root_x, root_y, root_z, root_qx, root_qy, root_qz, root_qw, dof_*</code>（机器人位置 xyz + 四元数 xyzw + 各自由度）</p>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap" title="仅影响导出文件，不重新求解">导出 FPS</label>
            <input class="search" id="rt-export-fps" type="number" min="1" step="1" style="flex:1"
              placeholder="留空 = Retarget 结果帧率" />
          </div>
          <div class="hint" id="rt-export-srcfps" style="margin-top:4px">
            <b>导出 FPS</b>：只对已算好的机器人关节轨迹做时间重采样（插值），<b>不会</b>重新 IK/MPC。与上方的 Retarget FPS 无关；可 Retarget 用 30 fps、导出再降到 15 fps。
          </div>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap" title="相对 Retarget 结果时间轴">起始 (s)</label>
            <input class="search" id="rt-export-t-start" type="number" min="0" step="0.01" style="flex:1"
              placeholder="留空 = 0" />
            <label class="k" style="white-space:nowrap">截止 (s)</label>
            <input class="search" id="rt-export-t-end" type="number" min="0" step="0.01" style="flex:1"
              placeholder="留空 = 结尾" />
          </div>
          <p class="hint" style="margin-top:4px">可选：只导出 clip 中一段；时间相对 Retarget 播放轴，导出后 <code>time</code> 从 0 重计。物体轨迹同步裁剪。</p>
          <div class="row" style="margin-top:8px">
            <select class="search" id="rt-export-format" style="flex:1">
              <option value="csv" selected>CSV（机器人 + 物体轨迹，默认）</option>
              <option value="pkl">PKL（机器人 + 物体轨迹）</option>
            </select>
          </div>
          <label class="row" style="margin-top:8px; gap:8px; align-items:center; cursor:pointer">
            <input type="checkbox" id="rt-csv-header" checked />
            <span class="hint" style="margin:0">CSV 含注释与列名表头</span>
          </label>
          <p class="hint" style="margin-top:4px">取消勾选后 CSV 从第一行纯数值开始（无 <code>#</code> 注释、无列名）。</p>
          <div style="height:10px"></div>
          <button class="btn secondary" id="rt-export-btn">下载导出包</button>
          <p class="hint" id="rt-export-bundle-hint" style="margin-top:6px;display:none">
            含交互物体/地形时将下载 ZIP：<code>&lt;clip&gt;.csv|.pkl</code>（机器人）、<code>object_&lt;i&gt;_&lt;name&gt;.csv|.pkl</code>（物体 retarget 轨迹，与所选格式一致；位姿为机器人坐标系，几何见同目录 <code>.obj</code>）、以及按机器人尺度缩放的 <code>_terrain.obj</code> / 物体 <code>.obj</code>（布局同 OMOMO / meshmimic clip 文件夹）。
          </p>
          </div>
        </div>
      </section>

      <!-- BATCH -->
      <section class="panel" :class="{ active: activePanel === 'batch' }" data-panel="batch">
        <h2>批量 Batch</h2>
        <p class="lead">把要 retarget 的数据拖进篮子，一次性批量导出。</p>

        <div class="dropzone" id="basket-drop">
          <div class="dz-glyph">🧺</div>
          <div class="dz-title">拖入文件 / 文件夹到篮子</div>
          <div class="dz-sub">支持任意路径的数据集（会话缓存，重启即清除）；也可在「动作」资源库点 ＋ 加入</div>
        </div>

        <div class="card">
          <h3>篮子 <span id="basket-count">0</span> 项</h3>
          <div class="basket-list" id="basket-list"></div>
          <div class="divider"></div>
          <button class="btn secondary small" id="basket-clear">清空篮子</button>
        </div>

        <div class="card">
          <h3>批量参数</h3>
          <div class="meta-row"><span class="k">机器人</span><span class="v" id="batch-robot">未加载</span></div>
          <p class="hint" id="batch-ref-hint" style="margin-top:6px"></p>
          <select class="search" id="batch-backend">
            <option value="newton">Newton IK（GPU 批量）</option>
            <option value="interaction_mesh">Interaction-Mesh（逐条）</option>
          </select>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap">批量并行数</label>
            <input class="search" id="batch-size" type="number" min="1" max="256" step="1" style="flex:1"
              value="16" />
          </div>
          <p class="hint" style="margin-top:8px">Newton：多条 clip 在 GPU 上<strong>并行</strong>求解（每条子问题独立 dof×dof 内核，与并行数无关，不再受“多 clip 共享内存”限制）。并行数越大越快、占用显存/内存越多；超出设备能力会自动下调。Interaction-Mesh 始终逐条 MPC。</p>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap">Retarget FPS</label>
            <input class="search" id="batch-retarget-fps" type="number" min="1" step="1" style="flex:1"
              placeholder="留空 = 原始" />
          </div>
          <p class="hint" style="margin-top:4px">批量求解前对人体动作抽帧；低于原始帧率可加速，可能损质量。</p>
          <div class="row" style="margin-top:8px; gap:8px">
            <select class="search" id="batch-format" style="flex:1">
              <option value="csv">CSV（可读，单文件）</option>
              <option value="pkl">PKL（更小，含地形/物体，适合批量）</option>
            </select>
            <input class="search" id="batch-export-fps" type="number" min="1" step="1" style="flex:0 0 42%"
              placeholder="导出 FPS" title="留空 = 与 Retarget 相同" />
          </div>
          <p class="hint" style="margin-top:4px">导出 FPS：仅对机器人轨迹插值写文件，不重新求解。大批量优先选 <b>PKL</b>（写盘更快）；CSV 批量打包使用无压缩 ZIP 以加速。
          </p>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap">起始 (s)</label>
            <input class="search" id="batch-export-t-start" type="number" min="0" step="0.01" style="flex:1"
              placeholder="留空 = 0" title="对篮子内每条 clip 统一裁剪" />
            <label class="k" style="white-space:nowrap">截止 (s)</label>
            <input class="search" id="batch-export-t-end" type="number" min="0" step="0.01" style="flex:1"
              placeholder="留空 = 结尾" />
          </div>
          <p class="hint" style="margin-top:4px">可选：导出时对每条 clip 裁同一时间窗（相对各 clip 的 Retarget 时间轴）；超出该 clip 长度的截止会夹到结尾。</p>
          <label class="row" style="margin-top:8px; gap:8px; align-items:center; cursor:pointer">
            <input type="checkbox" id="batch-csv-header" checked />
            <span class="hint" style="margin:0">CSV 含注释与列名表头</span>
          </label>
          <div style="height:8px"></div>
          <input class="search" id="batch-out" placeholder="ZIP 文件名（不含扩展名）" value="batch_export" />
          <p class="hint" id="batch-fmt-note" style="margin-top:8px">
            完成后由浏览器下载 ZIP（保存到系统默认下载目录，<b>不会</b>写入本项目）。目录层级与源数据一致：扁平数据集（如 AMASS）为 <code>AMASS/clip.csv</code>；含物体/地形的 clip 为 <code>OMOMO/clip/clip.csv + 附属文件</code>；外部拖入保持拖入时的相对路径。<br>
            CSV 列：<code>time, root_xyz, root_qxyzw, dof_*</code>。
          </p>
          <div style="height:10px"></div>
          <button class="btn" id="batch-run" disabled>批量 Retarget 并导出</button>
          <div style="height:10px"></div>
          <div class="batch-progress-stack hidden" id="batch-progress-stack">
            <div class="batch-progress-row">
              <span class="batch-progress-label">总进度</span>
              <div class="progress" id="batch-progress-total"><div class="bar"></div></div>
            </div>
            <div class="batch-progress-row">
              <span class="batch-progress-label">当前批次</span>
              <div class="progress" id="batch-progress-clip"><div class="bar"></div></div>
            </div>
          </div>
          <div class="hint" id="batch-status" style="margin-top:8px"></div>
          <div class="batch-failures hidden" id="batch-failures"></div>
        </div>
      </section>

      <!-- ROBOT-TO-ROBOT (R2R) -->
      <section class="panel" :class="{ active: activePanel === 'r2r' }" data-panel="r2r">
        <h2>机器人 → 机器人 R2R</h2>
        <p class="lead">把已有的 <b>G1 机器人轨迹</b>（<code>.pkl / .npz / .csv</code>，须为本工具导出格式）重定向到<b>任意其他机器人</b>。CSV 支持两种导出样式：<b>含</b> <code>#</code> 注释与列名表头，或<b>取消勾选表头后</b>从第一行起的纯数值（无注释、无表头，帧率由 <code>time</code> 列推算）。流程：源机器人 → 上传轨迹播放 → 目标机器人 → 标定 → Retarget → 导出。</p>
        <WorkflowPipeline workflow="r2r" />

        <div class="card">
          <h3>1 · 源机器人（轨迹来源）</h3>
          <select class="search" id="r2r-source-select"></select>
          <p class="hint" style="margin-top:6px">轨迹通常由 G1 导出，默认选 Unitree G1。源机器人用于<b>正运动学</b>还原关键点。</p>
          <div class="row" style="margin-top:8px">
            <button class="btn secondary small" id="r2r-source-load" style="flex:1">加载源机器人</button>
          </div>
          <p class="hint" id="r2r-source-status" style="margin-top:6px">尚未加载源机器人。</p>
        </div>

        <div class="card">
          <h3>2 · 上传源轨迹</h3>
          <div class="robot-import-grid">
            <div class="dropzone dropzone-compact" id="r2r-drop-mimic" data-r2r-profile="mimic">
              <div class="dz-glyph">🎞️</div>
              <div class="dz-title">mimic · 通用</div>
              <div class="dz-sub">单文件或含多级子目录的 <code>.csv/.pkl/.npz</code></div>
              <div class="row" style="margin-top:10px">
                <button type="button" class="btn secondary small" data-r2r-pick="mimic">选择文件</button>
                <button type="button" class="btn secondary small" data-r2r-pick="mimic" data-folder="1">文件夹</button>
              </div>
            </div>
            <div class="dropzone dropzone-compact" id="r2r-drop-intermimic" data-r2r-profile="intermimic">
              <div class="dz-glyph">📦</div>
              <div class="dz-title">intermimic</div>
              <div class="dz-sub">须拖入<b>文件夹</b>：轨迹 + <code>*_cleaned_simplified.obj</code></div>
              <div class="row" style="margin-top:10px">
                <button type="button" class="btn secondary small" data-r2r-pick="intermimic" data-folder="1">选择文件夹</button>
              </div>
            </div>
            <div class="dropzone dropzone-compact" id="r2r-drop-meshmimic" data-r2r-profile="meshmimic">
              <div class="dz-glyph">⛰️</div>
              <div class="dz-title">meshmimic</div>
              <div class="dz-sub">须拖入<b>文件夹</b>：轨迹 + <code>*_terrain.obj</code></div>
              <div class="row" style="margin-top:10px">
                <button type="button" class="btn secondary small" data-r2r-pick="meshmimic" data-folder="1">选择文件夹</button>
              </div>
            </div>
          </div>
          <div class="row" style="margin-top:10px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap" title="无 time/sample_rate 的外来 CSV（如 MotionDecode）使用此值">源轨迹 FPS</label>
            <input class="search" id="r2r-source-fps" type="number" min="1" step="1" value="50" style="flex:1" />
          </div>
          <p class="hint" style="margin-top:4px">默认 50。无时间戳的外来轨迹请按真实采集帧率填写（例如 120）；自有导出带 <code>time</code> / <code># sample_rate</code> 时仍按文件识别。</p>
          <p class="hint" id="r2r-traj-status" style="margin-top:8px">先加载源机器人，再上传轨迹即可播放。</p>
          <div class="progress" style="display:none; margin-top:8px" id="r2r-traj-progress"><div class="bar"></div></div>
        </div>

        <div class="card">
          <h3>3 · 目标机器人</h3>
          <p class="hint" style="margin-top:0">先在「机器人 Robot Registry」注册你的机器人（URDF + meshes），这里即可选择。</p>
          <select class="search" id="r2r-target-select"></select>
          <div class="row" style="margin-top:8px">
            <button class="btn secondary small" id="r2r-target-load" style="flex:1">加载目标机器人</button>
          </div>
          <p class="hint" id="r2r-target-status" style="margin-top:6px">尚未加载目标机器人。</p>
        </div>

        <div class="section-rule"><span>Retarget</span></div>

        <div class="card">
          <h3>4 · 标定 Calibration</h3>
          <div class="meta-row"><span class="k">标定</span><span class="v" id="r2r-cal"><span class="status-chip"><span class="dot"></span>—</span></span></div>
          <div class="calibration-principle" style="margin-top:8px">
            调整目标机器人，使其与蓝色源机器人参考姿态在语义上对应。两台机器人结构和比例可以不同，<b>不要求逐点重合</b>。
          </div>
          <div class="calibration-scope" id="r2r-calibration-scope">配置范围：目标机器人 + 源机器人</div>
          <div class="validation-summary" id="r2r-calibration-validation-summary" aria-live="polite"></div>
          <p class="hint" style="margin-top:6px">蓝色参考姿态由源机器人零位 FK 得到。未标定时加载目标机器人会自动进入标定模式；可在 3D 舞台<b>点击关节拖动</b>，或使用下方滑块 / 浮动 HUD 微调。</p>
          <div style="height:8px"></div>
          <button class="btn secondary small" id="r2r-calib-btn" disabled>开始 / 重新标定</button>
          <div class="calibration-save-summary" id="r2r-calibration-save-summary" aria-live="polite"></div>
          <div id="r2r-calib-edit" style="display:none">
            <CalibrationEditorControls workflow="r2r" />
            <div id="r2r-calib-sliders" class="calibration-joint-list"></div>
            <div class="divider"></div>
            <div class="row">
              <button class="btn secondary small" id="r2r-calib-zero" title="全部关节置 0（URDF 零位）">归零</button>
              <button class="btn secondary small" id="r2r-calib-cancel">取消</button>
              <button class="btn small" id="r2r-calib-save">保存标定</button>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>5 · 执行 Retarget</h3>
          <select class="search" id="r2r-backend">
            <option value="newton">Newton IK（GPU）</option>
            <option value="interaction_mesh">Interaction-Mesh（MPC）</option>
          </select>
          <p class="hint" style="margin-top:6px">mimic 默认 Newton；intermimic / meshmimic（带物体/地形）默认 Interaction-Mesh。上传后会自动切换，也可手动改。</p>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap" title="求解前对源轨迹抽帧">Retarget FPS</label>
            <input class="search" id="r2r-retarget-fps" type="number" min="1" step="1" style="flex:1"
              placeholder="留空 = 轨迹原始帧率" />
          </div>
          <p class="hint" style="margin-top:6px"><b>首次较慢：</b>Newton 首次会编译 GPU/Warp IK 内核；Interaction-Mesh 逐帧 MPC，带地形 clip 更慢，进度条可能短暂不动，属正常现象。</p>
          <div style="height:8px"></div>
          <button class="btn" id="r2r-retarget-btn" disabled>开始 Retarget</button>
          <p class="disabled-action-reason" id="r2r-disabled-reason" role="status">请先加载源机器人、源轨迹与目标机器人。</p>
          <div style="height:10px"></div>
          <div class="progress" style="display:none" id="r2r-progress"><div class="bar"></div></div>
          <div class="hint" id="r2r-status" style="margin-top:8px"></div>
        </div>

        <ResultEvaluationPanel workflow="r2r" />

        <div class="card" id="r2r-export-card" style="display:none">
          <h3>6 · 导出</h3>
          <p class="hint">格式：<code>time, root_xyz, root_qxyzw, dof_*</code>（目标机器人轨迹）。</p>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap">导出 FPS</label>
            <input class="search" id="r2r-export-fps" type="number" min="1" step="1" style="flex:1"
              placeholder="留空 = Retarget 结果帧率" />
          </div>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap">起始 (s)</label>
            <input class="search" id="r2r-export-t-start" type="number" min="0" step="0.01" style="flex:1"
              placeholder="留空 = 0" />
            <label class="k" style="white-space:nowrap">截止 (s)</label>
            <input class="search" id="r2r-export-t-end" type="number" min="0" step="0.01" style="flex:1"
              placeholder="留空 = 结尾" />
          </div>
          <p class="hint" style="margin-top:4px">可选：只导出一段；时间相对 R2R 结果轴，导出 <code>time</code> 从 0 重计。</p>
          <div class="row" style="margin-top:8px">
            <select class="search" id="r2r-export-format" style="flex:1">
              <option value="csv" selected>CSV</option>
              <option value="pkl">PKL</option>
            </select>
          </div>
          <label class="row" style="margin-top:8px; gap:8px; align-items:center; cursor:pointer">
            <input type="checkbox" id="r2r-csv-header" checked />
            <span class="hint" style="margin:0">CSV 含注释与列名表头</span>
          </label>
          <p class="hint" id="r2r-export-bundle-hint" style="display:none; margin-top:8px">
            含地形/物体时将打包为 ZIP（目标机器人轨迹 + 缩放后的 OBJ / object_*.csv）。
          </p>
          <div style="height:10px"></div>
          <button class="btn secondary" id="r2r-export-btn">下载导出文件</button>
        </div>

        <div class="section-rule"><span>批量</span></div>

        <div class="card">
          <h3>7 · 批量 R2R</h3>
          <p class="hint">与上方三种 profile 相同：mimic 可文件/多级目录；intermimic / meshmimic 须<b>完整文件夹</b>（含物体/地形 sidecar）。批量导出与人体 Retarget 一致：meshmimic → <code>&lt;stem&gt;.csv</code> + <code>&lt;stem&gt;_terrain.obj</code>；intermimic → 机器人轨迹 + <code>object_*</code> 缩放轨迹 + <code>*_cleaned_simplified.obj</code>，按 clip 打 ZIP。总 ZIP 保留拖入目录层级。</p>
          <div class="dropzone" id="r2r-basket-drop">
            <div class="dz-glyph">🧺</div>
            <div class="dz-title">拖入待处理 clip</div>
            <div class="dz-sub">自动识别 mimic / intermimic / meshmimic</div>
          </div>
          <div class="meta-row" style="margin-top:8px"><span class="k">篮子</span><span class="v" id="r2r-basket-count">0</span></div>
          <div id="r2r-basket-list" style="margin-top:6px; max-height:120px; overflow-y:auto"></div>
          <div class="row" style="margin-top:8px">
            <button class="btn secondary small" id="r2r-basket-clear">清空篮子</button>
          </div>
          <select class="search" id="r2r-batch-backend" style="margin-top:8px">
            <option value="newton">Newton IK（GPU）</option>
            <option value="interaction_mesh">Interaction-Mesh（逐条 MPC）</option>
          </select>
          <p class="hint" style="margin-top:6px">批量使用同一求解器；混放 mimic 与 intermimic/meshmimic 时请按 clip 类型手动选择，或分两批跑。</p>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap">导出 FPS</label>
            <input class="search" id="r2r-batch-export-fps" type="number" min="1" step="1" style="flex:1" placeholder="留空 = Retarget 帧率" />
          </div>
          <div class="row" style="margin-top:8px; align-items:center; gap:8px">
            <label class="k" style="white-space:nowrap">起始 (s)</label>
            <input class="search" id="r2r-batch-t-start" type="number" min="0" step="0.01" style="flex:1" placeholder="留空 = 0" />
            <label class="k" style="white-space:nowrap">截止 (s)</label>
            <input class="search" id="r2r-batch-t-end" type="number" min="0" step="0.01" style="flex:1" placeholder="留空 = 结尾" />
          </div>
          <input class="search" id="r2r-batch-out" placeholder="ZIP 文件名" value="r2r_batch_export" style="margin-top:8px" />
          <label class="row" style="margin-top:8px; gap:8px; align-items:center; cursor:pointer">
            <input type="checkbox" id="r2r-batch-csv-header" checked />
            <span class="hint" style="margin:0">CSV 含注释与列名表头</span>
          </label>
          <div style="height:8px"></div>
          <button class="btn" id="r2r-batch-run" disabled>批量 Retarget 并导出</button>
          <div class="progress" style="display:none; margin-top:10px" id="r2r-batch-progress"><div class="bar"></div></div>
          <div class="hint" id="r2r-batch-status" style="margin-top:8px"></div>
        </div>
      </section>

      <section class="panel panel-dataset-viz" :class="{ active: activePanel === 'dataset-viz' }" data-panel="dataset-viz">
        <h2>数据集可视化分析</h2>

        <div class="dv-card dv-card-source">
          <div class="dv-card-head">
            <span class="dv-card-title">数据源</span>
            <span class="dv-card-badge" id="dv-kind-badge">—</span>
          </div>
          <div class="dv-dropzone" id="dv-dropzone">
            <div class="dv-drop-inner">
              <span class="dv-drop-icon" id="dv-drop-icon">📁</span>
              <span id="dv-drop-label">拖入<b>人体</b>或<b>机器人</b>数据集文件夹</span>
              <button type="button" class="btn secondary small" id="dv-pick-folder">选择文件夹</button>
            </div>
            <div class="hint dv-drop-hint" id="dv-drop-hint">留空 = 当前资源库根目录 · 可多次拖入追加到同一批次</div>
          </div>
          <div class="dv-upload-basket" id="dv-upload-basket" hidden>
            <div class="dv-basket-head">
              <span class="dv-basket-title" id="dv-basket-summary">—</span>
              <button type="button" class="btn-link" id="dv-clear-upload">清空批次</button>
            </div>
            <ul class="dv-basket-list" id="dv-basket-list"></ul>
          </div>
          <div class="dv-source-display" id="dv-source-display">未指定目录</div>
          <label class="dv-field dv-user-root" id="dv-user-root-wrap" hidden>
            <span>本地数据目录 <b>*</b></span>
            <input type="text" id="dv-user-source-root" class="dv-input"
              placeholder="/home/motions 或 /home/motions/sub10_largebox_000_export" />
            <span class="hint">拖入上传后必填：JSON manifest 会映射到此目录下的真实路径（非 /tmp）</span>
          </label>
          <details class="dv-support-compact" open>
            <summary>支持格式</summary>
            <div class="dv-format-grid" id="dv-format-grid"></div>
          </details>
          <input type="hidden" id="dv-source" value="" />
          <div class="dv-toolbar">
            <label class="dv-field">
              <span>Embedding</span>
              <select id="dv-embedding">
                <option value="handcrafted">档A · 手工特征（推荐）</option>
                <option value="pae" disabled>档B · PAE（预留，暂不可用）</option>
              </select>
            </label>
            <label class="dv-check"><input type="checkbox" id="dv-force" /> 忽略缓存</label>
            <button class="btn" id="dv-analyze">开始分析</button>
          </div>
          <div class="dv-robot-preview" id="dv-robot-preview" hidden>
            <label class="dv-field">
              <span>预览机器人</span>
              <select id="dv-robot-select"></select>
            </label>
            <span class="hint" id="dv-robot-hint">点击散点/列表 ▶ 将用 mesh 播放轨迹</span>
          </div>
          <div class="progress dv-progress" style="display:none" id="dv-progress"><div class="bar"></div></div>
          <div class="dv-status" id="dv-status"></div>
        </div>

        <div id="dv-results" hidden>
          <div class="dv-overview" id="dv-overview"></div>

          <div class="dv-card">
            <div class="dv-card-head">
              <span class="dv-card-title" id="dv-stage1-title">Stage I · 标签</span>
              <div class="dv-tagmode">
                <label><input type="radio" name="dv-tagmode" value="or" checked /> OR</label>
                <label><input type="radio" name="dv-tagmode" value="and" /> AND</label>
                <button type="button" class="btn-link" id="dv-clear-tags">清除</button>
              </div>
            </div>
            <div class="dv-chips" id="dv-chips"></div>
            <div class="dv-info-panel" id="dv-tag-info" hidden></div>
          </div>

          <div class="dv-card">
            <div class="dv-card-head">
              <span class="dv-card-title" id="dv-explore-title">探索 · 指标分布</span>
              <button type="button" class="btn-link" id="dv-clear-brush">清除刷选</button>
            </div>
            <div class="dv-row dv-row-tight">
              <select id="dv-view-dim" class="dv-select dv-select-grow"></select>
            </div>
            <div class="dv-info-panel dv-info-compact" id="dv-metric-info"></div>
            <div class="dv-chart-wrap">
              <canvas id="dv-hist-canvas" class="dv-canvas" width="640" height="240"></canvas>
            </div>
            <div class="dv-chart-footer">
              <span class="dv-chart-stats" id="dv-hist-stats"></span>
              <span class="hint" id="dv-hist-axis-hint"></span>
            </div>
          </div>

          <div class="dv-card">
            <div class="dv-card-head">
              <span class="dv-card-title" id="dv-stage2-title">Stage II · 语义散点</span>
              <button type="button" class="btn secondary small" id="dv-scatter-reset">默认视角</button>
            </div>
            <div class="dv-scatter-wrap">
              <canvas id="dv-scatter-canvas" class="dv-canvas dv-scatter" width="640" height="400"></canvas>
              <div class="dv-scatter-tip" id="dv-scatter-tip" hidden></div>
            </div>
            <div class="dv-scatter-toolbar">
              <span class="hint">滚轮缩放 · 拖拽平移 · 点击预览 · 非推荐点可手动补选 · Shift 多选</span>
              <div class="dv-legend" id="dv-legend"></div>
            </div>
            <div class="dv-clip-list-wrap">
              <div class="dv-list-head">
                <span>刷选结果</span>
                <span class="hint" id="dv-list-count"></span>
              </div>
              <div class="dv-clip-list" id="dv-clip-list"></div>
            </div>
          </div>

          <div class="dv-card dv-card-stage3">
            <div class="dv-card-head">
              <span class="dv-card-title" id="dv-stage3-title">Stage III · 子集推荐</span>
            </div>
            <div class="dv-slider-block">
              <div class="dv-slider-row">
                <label class="dv-slider-label">想要导出多少的子集</label>
                <span class="dv-slider-val" id="dv-subset-pct">10%</span>
              </div>
              <input type="range" id="dv-subset-ratio" class="dv-range" min="1" max="100" value="10" />
            </div>
            <div class="dv-slider-block">
              <div class="dv-slider-row">
                <label class="dv-slider-label">多样性 α
                  <span class="dv-tip" title="α 越大越重视 embedding 空间多样性；越小越偏向高复杂度 clip">?</span>
                </label>
                <span class="dv-slider-val" id="dv-subset-alpha-val">0.99</span>
              </div>
              <input type="range" id="dv-subset-alpha" class="dv-range" min="50" max="100" value="99" />
              <p class="hint dv-alpha-hint" id="dv-alpha-hint">α=0.99：优先选彼此差异大的 clip；降低 α 会更偏向高动态动作。</p>
            </div>
            <div class="dv-selbar" id="dv-selbar"></div>
            <div class="dv-robot-export-opts" id="dv-robot-export-opts" hidden>
              <label class="dv-check">
                <input type="checkbox" id="dv-robot-export-files" checked />
                打包轨迹文件夹 (ZIP)
              </label>
              <span class="hint">取消勾选 → 仅导出选中 clip 的 JSON 清单</span>
            </div>
            <div class="dv-actions-grid">
              <button type="button" class="btn" id="dv-human-basket" disabled>人体数据 → 批量篮子</button>
              <button type="button" class="btn" id="dv-export-robot" disabled>导出机器人数据</button>
              <button type="button" class="btn secondary" id="dv-export-json">导出 manifest (JSON)</button>
              <button type="button" class="btn secondary" id="dv-clear-sel">清除手动选中</button>
            </div>
            <div class="hint dv-clip-detail" id="dv-clip-detail"></div>
          </div>
        </div>
      </section>
      </div>
    </aside>

    <WorkspaceDrawerHandle
      side="right"
      :expanded="!panelLayout.state.inspectorHidden"
      :locale="workspaceLocale"
      @toggle="panelLayout.setHidden('inspector', !panelLayout.state.inspectorHidden)"
    />
    <JobDrawer docked :locale="workspaceLocale" />
    <WorkspaceSettingsDialog
      :open="settingsOpen"
      :locale="workspaceLocale"
      :sidebar-hidden="panelLayout.state.sidebarHidden"
      :inspector-hidden="panelLayout.state.inspectorHidden"
      :job-admission="jobAdmission"
      :job-admission-loading="jobAdmissionLoading"
      :job-admission-saving="jobAdmissionSaving"
      :job-admission-error="jobAdmissionError"
      :job-admission-error-operation="jobAdmissionErrorOperation"
      :job-admission-saved="jobAdmissionSaved"
      :motion-library="motionLibrarySettings"
      :motion-library-loading="motionLibrarySettingsLoading"
      :motion-library-saving="motionLibrarySettingsSaving"
      :motion-library-error="motionLibrarySettingsError"
      :motion-library-saved="motionLibrarySettingsSaved"
      @close="settingsOpen = false"
      @set-locale="setWorkspaceLocale"
      @set-hidden="panelLayout.setHidden"
      @reset="panelLayout.reset"
      @refresh-job-admission="loadJobAdmission"
      @save-job-admission="saveJobAdmission"
      @refresh-motion-library="loadMotionLibrarySettings"
      @select-motion-library-root="chooseMotionLibraryRoot"
    />
  </div>

  <div id="load-overlay" class="hidden">
    <div class="load-card">
      <div class="load-label" id="load-label">加载中…</div>
      <div class="progress"><div class="bar" id="load-bar"></div></div>
      <div class="load-sub" id="load-sub"></div>
    </div>
  </div>

  <div id="calib-banner" class="hidden">
    <span class="dot"></span>标定模式 · 请将灰色机器人对齐到蓝色参考骨架
  </div>

  <!-- Guided tour overlay -->
  <div id="tour-root" class="tour-root" aria-hidden="true">
    <div id="tour-highlight" class="tour-highlight"></div>
    <div id="tour-popover" class="tour-popover" role="dialog" aria-labelledby="tour-title">
      <div class="tour-popover-head">
        <span class="tour-step-badge" id="tour-step">1 / 9</span>
        <button type="button" class="tour-skip" id="tour-skip">跳过教程</button>
      </div>
      <h3 class="tour-title" id="tour-title">标题</h3>
      <p class="tour-body" id="tour-body"></p>
      <button type="button" class="btn tour-next" id="tour-next">知道了</button>
    </div>
  </div>

  <div id="toast"></div>
  <div id="boot-error" style="display:none;position:fixed;inset:auto 16px 16px 16px;z-index:200;
    background:#ff3b30;color:#fff;padding:12px 16px;border-radius:12px;font:14px/1.5 -apple-system,sans-serif">
  </div>
</template>
