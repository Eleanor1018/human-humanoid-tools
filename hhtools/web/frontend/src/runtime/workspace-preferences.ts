import type {
  ComparisonPreset,
  WorkspaceLocale,
  WorkspacePanelId,
  WorkspaceTheme,
  WorkflowId,
} from './types'

export interface WorkspacePreferences {
  activePanel: WorkspacePanelId
  locale: WorkspaceLocale
  theme: WorkspaceTheme
  playbackSpeed: number
  playbackLoop: boolean
  comparisonPresets: Record<WorkflowId, ComparisonPreset>
}

const STORAGE_KEY = 'hhtools-workspace-preferences-v1'

const DEFAULT_PREFERENCES: WorkspacePreferences = {
  activePanel: 'motion',
  locale: 'en',
  theme: 'light',
  playbackSpeed: 1,
  playbackLoop: true,
  comparisonPresets: {
    h2r: 'overlay',
    r2r: 'overlay',
  },
}

const PANELS = new Set<WorkspacePanelId>([
  'motion',
  'robot-assets',
  'video-to-motion',
  'h2r',
  'batch',
  'r2r',
  'dataset-viz',
])
const PRESETS = new Set<ComparisonPreset>(['source', 'target', 'result', 'overlay'])
const LOCALES = new Set<WorkspaceLocale>(['en', 'zh-CN'])
const THEMES = new Set<WorkspaceTheme>(['light', 'dark'])

function clampSpeed(value: unknown): number {
  const speed = Number(value)
  return Number.isFinite(speed) ? Math.min(4, Math.max(0.1, speed)) : 1
}

export function loadWorkspacePreferences(): WorkspacePreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<WorkspacePreferences>
    const storedPanel = saved.activePanel as unknown
    // Migrate the retired standalone Video workspace into the unified workflow.
    const activePanel = storedPanel === 'video'
      ? 'video-to-motion'
      : PANELS.has(storedPanel as WorkspacePanelId)
        ? storedPanel as WorkspacePanelId
        : DEFAULT_PREFERENCES.activePanel
    const comparisonPresets = { ...DEFAULT_PREFERENCES.comparisonPresets }
    for (const workflow of ['h2r', 'r2r'] as const) {
      const preset = saved.comparisonPresets?.[workflow]
      if (PRESETS.has(preset as ComparisonPreset)) comparisonPresets[workflow] = preset as ComparisonPreset
    }
    return {
      activePanel,
      locale: LOCALES.has(saved.locale as WorkspaceLocale)
        ? saved.locale as WorkspaceLocale
        : DEFAULT_PREFERENCES.locale,
      theme: THEMES.has(saved.theme as WorkspaceTheme)
        ? saved.theme as WorkspaceTheme
        : DEFAULT_PREFERENCES.theme,
      playbackSpeed: clampSpeed(saved.playbackSpeed),
      playbackLoop: typeof saved.playbackLoop === 'boolean'
        ? saved.playbackLoop
        : DEFAULT_PREFERENCES.playbackLoop,
      comparisonPresets,
    }
  } catch {
    return structuredClone(DEFAULT_PREFERENCES)
  }
}

export function updateWorkspacePreferences(
  patch: Partial<Omit<WorkspacePreferences, 'comparisonPresets'>> & {
    comparisonPresets?: Partial<Record<WorkflowId, ComparisonPreset>>
  },
): WorkspacePreferences {
  const current = loadWorkspacePreferences()
  const next: WorkspacePreferences = {
    ...current,
    ...patch,
    comparisonPresets: {
      ...current.comparisonPresets,
      ...patch.comparisonPresets,
    },
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  return next
}
