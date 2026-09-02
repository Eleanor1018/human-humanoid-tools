/**
 * Versioned persistence boundary for UI-only workspace preferences. Backend
 * settings (job admission, model paths, and library roots) do not belong here.
 * Every value read from localStorage is validated before entering React state.
 */

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

function readSystemLanguageTags(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return [...navigator.languages, navigator.language]
}

export function resolveSystemLocale(
  languageTags: readonly string[] = readSystemLanguageTags(),
): WorkspaceLocale {
  for (const languageTag of languageTags) {
    const primaryLanguage = languageTag.trim().toLowerCase().split(/[-_]/, 1)[0]
    if (primaryLanguage === 'zh') return 'zh-CN'
    if (primaryLanguage === 'en') return 'en'
  }
  return DEFAULT_PREFERENCES.locale
}

function clampSpeed(value: unknown): number {
  const speed = Number(value)
  return Number.isFinite(speed) ? Math.min(4, Math.max(0.1, speed)) : 1
}

/** Parse, migrate, and normalize storage into a complete preference object. */
export function loadWorkspacePreferences(
  systemLanguageTags: readonly string[] = readSystemLanguageTags(),
): WorkspacePreferences {
  const defaultPreferences: WorkspacePreferences = {
    ...structuredClone(DEFAULT_PREFERENCES),
    locale: resolveSystemLocale(systemLanguageTags),
  }

  try {
    // Treat persisted data as untrusted and merge it field-by-field so an older
    // or hand-edited record cannot introduce unsupported panels or enum values.
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<WorkspacePreferences>
    const storedPanel = saved.activePanel as unknown
    // Migrate the retired standalone Video workspace into the unified workflow.
    const activePanel = storedPanel === 'video'
      ? 'video-to-motion'
      : PANELS.has(storedPanel as WorkspacePanelId)
        ? storedPanel as WorkspacePanelId
        : defaultPreferences.activePanel
    const comparisonPresets = { ...defaultPreferences.comparisonPresets }
    for (const workflow of ['h2r', 'r2r'] as const) {
      const preset = saved.comparisonPresets?.[workflow]
      if (PRESETS.has(preset as ComparisonPreset)) comparisonPresets[workflow] = preset as ComparisonPreset
    }
    return {
      activePanel,
      locale: LOCALES.has(saved.locale as WorkspaceLocale)
        ? saved.locale as WorkspaceLocale
        : defaultPreferences.locale,
      theme: THEMES.has(saved.theme as WorkspaceTheme)
        ? saved.theme as WorkspaceTheme
        : defaultPreferences.theme,
      playbackSpeed: clampSpeed(saved.playbackSpeed),
      playbackLoop: typeof saved.playbackLoop === 'boolean'
        ? saved.playbackLoop
        : defaultPreferences.playbackLoop,
      comparisonPresets,
    }
  } catch {
    return defaultPreferences
  }
}

export function updateWorkspacePreferences(
  patch: Partial<Omit<WorkspacePreferences, 'comparisonPresets'>> & {
    comparisonPresets?: Partial<Record<WorkflowId, ComparisonPreset>>
  },
): WorkspacePreferences {
  // Read-modify-write preserves fields owned by other workbench components.
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
