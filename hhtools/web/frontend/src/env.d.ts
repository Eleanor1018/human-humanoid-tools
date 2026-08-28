/// <reference types="vite/client" />

import type {
  CalibrationEditorCommandDetail,
  CalibrationEditorStateDetail,
  ComparisonCommandDetail,
  ComparisonStateDetail,
  HhAppBridge,
  ImportCommandDetail,
  JobHistoryCommandDetail,
  JobHistoryStateDetail,
  PlaybackCommandDetail,
  PlaybackUiState,
  ResultDiagnosticsDetail,
  UploadFile,
  VideoToMotionStateDetail,
  WorkflowStateDetail,
} from './runtime/types'
import type { GuidedTour } from './runtime/tutorial'

export type HHToolsInputId =
  | 'lib-search'
  | 'robot-library-search'
  | 'rt-retarget-fps'
  | 'rt-export-fps'
  | 'rt-export-t-start'
  | 'rt-export-t-end'
  | 'rt-csv-header'
  | 'batch-size'
  | 'batch-retarget-fps'
  | 'batch-export-fps'
  | 'batch-export-t-start'
  | 'batch-export-t-end'
  | 'batch-csv-header'
  | 'batch-out'
  | 'r2r-source-fps'
  | 'r2r-retarget-fps'
  | 'r2r-export-fps'
  | 'r2r-export-t-start'
  | 'r2r-export-t-end'
  | 'r2r-csv-header'
  | 'r2r-batch-export-fps'
  | 'r2r-batch-t-start'
  | 'r2r-batch-t-end'
  | 'r2r-batch-out'
  | 'r2r-batch-csv-header'
  | 'dv-user-source-root'
  | 'dv-source'
  | 'dv-force'
  | 'dv-robot-export-files'
  | 'dv-subset-ratio'
  | 'dv-subset-alpha'

export type HHToolsSelectId =
  | 'lib-category'
  | 'rt-ref-select'
  | 'rt-backend'
  | 'rt-export-format'
  | 'batch-backend'
  | 'batch-format'
  | 'r2r-source-select'
  | 'r2r-target-select'
  | 'r2r-backend'
  | 'r2r-export-format'
  | 'r2r-batch-backend'
  | 'dv-embedding'
  | 'dv-robot-select'
  | 'dv-view-dim'

export type HHToolsCanvasId = 'three-canvas' | 'dv-hist-canvas' | 'dv-scatter-canvas'

export type HHToolsKnownId =
  | HHToolsInputId
  | HHToolsSelectId
  | HHToolsCanvasId
  | HHToolsButtonId
  | `basket-${string}`
  | `batch-${string}`
  | `boot-${string}`
  | `calib-${string}`
  | `dv-${string}`
  | `lib-${string}`
  | `load-${string}`
  | `motion-${string}`
  | `gvhmr-${string}`
  | `r2r-${string}`
  | `robot-${string}`
  | `rt-${string}`
  | `stage${string}`
  | `tg-${string}`
  | `tour-${string}`
  | `view-${string}`
  | 'add-to-basket'
  | 'nav-tour'
  | 'recalib-btn'
  | 'retarget-btn'
  | 'toast'
  | 'ui-build'

export type HHToolsButtonId =
  | 'toggle-sidebar'
  | 'toggle-inspector'
  | 'nav-tour'
  | 'view-reset-btn'
  | 'tg-skeleton'
  | 'tg-mesh'
  | 'tg-env'
  | 'tg-scaled'
  | 'tg-scaled-env'
  | 'tg-robot'
  | 'r2r-tg-src-robot'
  | 'r2r-tg-src-skel'
  | 'r2r-tg-src-env'
  | 'r2r-tg-tgt-robot'
  | 'r2r-tg-tgt-skel'
  | 'r2r-tg-tgt-env'
  | 'lib-link-path'
  | 'add-to-basket'
  | 'robot-pick-urdf'
  | 'robot-pick-mesh-folder'
  | 'recalib-btn'
  | 'calib-zero'
  | 'calib-restore'
  | 'calib-cancel'
  | 'calib-save'
  | 'retarget-btn'
  | 'rt-export-btn'
  | 'basket-clear'
  | 'batch-run'
  | 'r2r-source-load'
  | 'r2r-target-load'
  | 'r2r-calib-btn'
  | 'r2r-calib-zero'
  | 'r2r-calib-cancel'
  | 'r2r-calib-save'
  | 'r2r-retarget-btn'
  | 'r2r-export-btn'
  | 'r2r-basket-clear'
  | 'r2r-batch-run'
  | 'dv-pick-folder'
  | 'dv-clear-upload'
  | 'dv-analyze'
  | 'dv-clear-tags'
  | 'dv-clear-brush'
  | 'dv-scatter-reset'
  | 'dv-human-basket'
  | 'dv-export-robot'
  | 'dv-export-json'
  | 'dv-clear-sel'
  | 'tour-skip'
  | 'tour-next'

export type HHToolsElementForId<Id extends string> =
  Id extends HHToolsInputId ? HTMLInputElement
    : Id extends HHToolsSelectId ? HTMLSelectElement
      : Id extends HHToolsCanvasId ? HTMLCanvasElement
        : Id extends HHToolsButtonId ? HTMLButtonElement
          : HTMLElement

declare global {
  interface Document {
    /** The Vue template owns these elements before the imperative 3D runtime starts. */
    getElementById<Id extends HHToolsKnownId>(elementId: Id): HHToolsElementForId<Id>
  }

  interface HTMLElement {
    _timer?: ReturnType<typeof setTimeout>
  }

  interface File {
    _relpath?: string
  }

  interface Window {
    hhtoolsDesktop?: {
      getRuntimeState: () => Promise<unknown>
      restartBackend: () => Promise<unknown>
      selectDirectory: () => Promise<string | null>
      openExternal: (url: string) => Promise<void>
      onRuntimeStateChanged: (listener: (state: unknown) => void) => () => void
    }
    __hhtoolsReady?: boolean
    showBoot?: (message: string) => void
    __hhPanelLayout?: {
      revealBoth: () => void
      reset: () => void
    }
    __hhUi?: {
      setActivePanel: (panel: string) => void
      requestPanel: (panel: string) => void
    }
    __hhApp?: HhAppBridge
    __hh?: Record<string, unknown>
    __hhTour?: GuidedTour
  }

  interface WindowEventMap {
    'hhtools:calibration-editor-command': CustomEvent<CalibrationEditorCommandDetail>
    'hhtools:calibration-editor-state': CustomEvent<CalibrationEditorStateDetail>
    'hhtools:comparison-command': CustomEvent<ComparisonCommandDetail>
    'hhtools:comparison-state': CustomEvent<ComparisonStateDetail>
    'hhtools:job-history-command': CustomEvent<JobHistoryCommandDetail>
    'hhtools:job-history-state': CustomEvent<JobHistoryStateDetail>
    'hhtools:import-command': CustomEvent<ImportCommandDetail>
    'hhtools:job-spec-import-request': CustomEvent<void>
    'hhtools:panel-request': CustomEvent<string>
    'hhtools:playback-command': CustomEvent<PlaybackCommandDetail>
    'hhtools:playback-state': CustomEvent<Partial<PlaybackUiState>>
    'hhtools:result-diagnostics': CustomEvent<ResultDiagnosticsDetail>
    'hhtools:video-to-motion-state': CustomEvent<VideoToMotionStateDetail>
    'hhtools:workflow-state': CustomEvent<WorkflowStateDetail>
  }
}

export {}
