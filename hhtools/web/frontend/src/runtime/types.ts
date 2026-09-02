/**
 * Shared protocol types at the React ↔ compatibility runtime ↔ FastAPI seams.
 * This file contains data shapes only: importing it must never start a job,
 * touch the DOM, or create Three.js objects. Snake_case fields intentionally
 * mirror backend JSON; camelCase fields describe renderer-owned UI state.
 */

import type * as THREE from 'three'
import type {
  JobCliResponse,
  JobConfigResponse,
  JobHistoryRecord,
  JobListResponse,
  JobParameterValue,
  JobReplayResponse,
  JobSpecValidationResponse,
  JobStatus,
} from '@/domain/jobs/job'
import type {
  LibraryEntry,
  MotionPayload,
  Quaternion,
  ScenePayload,
  Vec3,
} from '@/domain/motion/common/motion'
import type { WorkspacePanelId } from '@/workbench/common/workspace'

// ---------------------------------------------------------------------------
// Remaining robot geometry and renderer playback contracts.

export type Matrix4Data = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

export interface PlaybackPayload {
  playback_duration?: number
  playback_frames?: number
  positions?: unknown[]
  frames?: unknown[]
  num_frames_total?: number
  framerate?: number
  sample_rate?: number
  duration?: number
}

export interface PlaybackUiState {
  visible: boolean
  active: boolean
  playing: boolean
  loop: boolean
  currentTime: number
  duration: number
  previewSourceDuration: number | null
  progress: number
  speed: number
  label: string
}

// ---------------------------------------------------------------------------
// Workbench identities and typed CustomEvent payloads.

export type PlaybackAction = 'toggle' | 'seek' | 'speed' | 'loop'

export type WorkflowId = 'h2r' | 'r2r'

export type ComparisonPreset = 'source' | 'target' | 'result' | 'overlay'

export type ImportCommandTarget =
  | 'motion-file'
  | 'motion-folder'
  | 'video-file'
  | 'robot-urdf'
  | 'robot-mesh-folder'
  | 'robot-trajectory'
  | 'dataset-folder'
  | 'job-spec'

export interface ImportCommandDetail {
  target: ImportCommandTarget
}

export type CalibrationJointRegion =
  | 'torso'
  | 'left-arm'
  | 'right-arm'
  | 'left-leg'
  | 'right-leg'
  | 'head'
  | 'hands'
  | 'other'

export type CalibrationAngleUnit = 'rad' | 'deg'
export type CalibrationComparisonMode = 'current' | 'saved' | 'zero'

export type CalibrationEditorCommand =
  | 'search'
  | 'region'
  | 'unit'
  | 'comparison'
  | 'reset-region'
  | 'mapped-only'
  | 'labels'
  | 'mapping-lines'
  | 'source-opacity'
  | 'robot-opacity'

export interface CalibrationEditorCommandDetail {
  workflow: WorkflowId
  command: CalibrationEditorCommand
  value?: string | number | boolean
}

export interface CalibrationEditorStateDetail {
  workflow: WorkflowId
  active: boolean
  totalJoints: number
  visibleJoints: number
  mappedLandmarks: number
  canUseSaved: boolean
  query: string
  region: CalibrationJointRegion | 'all'
  unit: CalibrationAngleUnit
  comparison: CalibrationComparisonMode
  mappedOnly: boolean
  labels: boolean
  mappingLines: boolean
  sourceOpacity: number
  robotOpacity: number
}

export type WorkflowNodeState =
  | 'missing'
  | 'validating'
  | 'ready'
  | 'running'
  | 'completed'
  | 'warning'
  | 'failed'

export interface WorkflowNodeStatus {
  id: string
  label: string
  state: WorkflowNodeState
  detail: string
  panel: WorkspacePanelId
}

export interface WorkflowStateDetail {
  workflow: WorkflowId
  nodes: WorkflowNodeStatus[]
  blockedReason: string | null
}

export type DataAnalysisKind = 'human' | 'robot' | 'mixed' | 'unknown'

export type DataAnalysisStage = 'idle' | 'uploading' | 'running' | 'completed' | 'failed'

/** Minimal renderer state for the dataset-analysis workflow navigation. */
export interface DataAnalysisStateDetail {
  dataKind: DataAnalysisKind
  clipCount: number
  stage: DataAnalysisStage
  progress: number
  message: string
  hasResults: boolean
}

export interface PlaybackCommandDetail {
  action: PlaybackAction
  value?: number
}

// ---------------------------------------------------------------------------
// Robot models, trajectories, and calibration sessions.

export interface RobotFrame {
  root?: [number, number, number, number, number, number, number]
  mesh_z_lift?: number
  links: Record<string, Matrix4Data>
}

export interface RobotTrajectoryPayload {
  frames: RobotFrame[]
  frame_indices?: number[]
  duration?: number
  playback_duration?: number
  playback_frames?: number
  num_frames_total?: number
  framerate?: number
  sample_rate?: number
}

export interface RobotJointMeta {
  name: string
  lower?: number
  upper?: number
  value?: number
  parent?: string
}

export interface RobotPayload {
  name: string
  display_name: string
  links: string[]
  mesh_to_link?: Record<string, string>
  link_transforms_zero: Record<string, Matrix4Data>
  ground_offset_z?: number
  glb_base64?: string | null
  joints?: RobotJointMeta[]
  joint_limits?: RobotJointLimit[]
  actuated_joints?: string[]
  num_dof?: number
  ik_map?: Record<string, unknown>
  ik_prewarmed?: boolean
}

export interface RobotSummary {
  name: string
  display_name: string
  has_urdf: boolean
  num_dof: number
  builtin?: boolean
  deletable: boolean
}

export interface RobotsResponse {
  robots: RobotSummary[]
  library_dir: string
}

export interface RobotJointLimit {
  name: string
  lower?: number
  upper?: number
  value?: number
  type?: string
  child_link?: string
  parent_link?: string
  axis?: Vec3
}

export interface CalibrationReferencePayload {
  positions: Vec3[][]
  parent_indices: number[]
  exclude_joint_indices?: number[]
  color?: number
  bone_names?: string[]
  canonical_names?: string[]
  quaternions?: Quaternion[][]
}

export interface JointWorldPayload {
  pivot?: Vec3
  axis?: Vec3
}

export interface CalibrationSession {
  reference?: CalibrationReferencePayload
  reference_pose?: CalibrationReferencePayload
  joint_q?: Record<string, number>
  saved_joint_q?: Record<string, number>
  limits?: RobotJointLimit[]
  joint_limits?: RobotJointLimit[]
  joint_world?: Record<string, JointWorldPayload>
  ground_offset_z?: number
  reference_name?: string
  has_saved_calibration?: boolean
}

export interface FkPreviewResponse {
  links: string[]
  link_transforms: Record<string, Matrix4Data>
  joint_world: Record<string, JointWorldPayload>
  ground_offset_z: number
}

export interface CalibrationStatus {
  calibrated: boolean
  bundled?: boolean
  path?: string | null
  joint_q?: Record<string, number> | null
}

// ---------------------------------------------------------------------------
// Motion library entries and retarget workflow results.

export interface LibraryResponse {
  source_root: string
  motions_library_root: string
  folders: string[]
  entries: LibraryEntry[]
}

export interface JobStartResponse {
  job_id: string
  linked?: boolean
  folder_label?: string
  materialize_mode?: 'pending' | 'symlink' | 'hardlink' | 'copy' | string
}

export interface RobotExportPreviewResult {
  name: string
  robot: string
  trajectory: RobotTrajectoryPayload
  num_frames: number
  framerate: number
  preview_token?: string
  scaled_scene?: ScenePayload
}

export interface TrackingDiagnosticPoint {
  frame: number
  time_s: number
  mean_error_m: number
  max_error_m: number
  source_contacts: number
  target_contacts: number
}

export interface EffectorDiagnostic {
  canonical: string
  target_link: string
  sample_count: number
  mean_error_m: number
  p95_error_m: number
  max_error_m: number
}

export interface FootContactDiagnostic {
  side: 'left' | 'right'
  canonical: string
  target_link: string
  agreement_ratio: number
  recall_ratio: number
  source_contact_ratio: number
  target_contact_ratio: number
  target_slide_mean_mps: number
  target_slide_p95_mps: number
}

export interface ContactDiagnostics {
  available: boolean
  reason?: string
  agreement_ratio?: number
  recall_ratio?: number
  target_slide_mean_mps?: number
  target_slide_p95_mps?: number
  feet: FootContactDiagnostic[]
}

export interface ResultDiagnostics {
  schema_version: number
  available: boolean
  reason?: string
  frame_count?: number
  mapped_effectors?: number
  requested_effectors?: number
  tracking?: {
    mean_error_m: number
    p95_error_m: number
    max_error_m: number
    effectors: EffectorDiagnostic[]
    series: TrackingDiagnosticPoint[]
  }
  contact?: ContactDiagnostics
}

export interface ResultDiagnosticsDetail {
  workflow: WorkflowId
  diagnostics: ResultDiagnostics | null
  comparisonPreset: ComparisonPreset
}

export interface ComparisonCommandDetail {
  workflow: WorkflowId
  preset: ComparisonPreset
}

export interface ComparisonStateDetail {
  workflow: WorkflowId
  preset: ComparisonPreset
}

export interface RetargetResult {
  motion_source_fps?: number
  retarget_fps?: number
  source_fps?: number
  num_frames: number
  trajectory: RobotTrajectoryPayload
  scaled_preview?: MotionPayload
  scaled_scene?: ScenePayload
  diagnostics?: ResultDiagnostics
  export_token: string
  has_scene?: boolean
  stem?: string
}

export interface R2rSourceTrajectoryResult {
  token: string
  name?: string
  has_scene?: boolean
  suggested_backend?: string
  trajectory: RobotTrajectoryPayload
  skeleton_preview?: MotionPayload
  num_frames: number
  framerate: number
  scaled_scene?: ScenePayload
  upload_profile?: string
}

export interface R2rBasketUploadResult {
  entries: LibraryEntry[]
  profile?: string
}

export interface BatchFailure {
  stage?: string
  stem?: string
  reason?: string
  log_rel?: string
  stash_error?: string
}

export interface BatchRetargetResult {
  solver_mode?: string
  failures?: BatchFailure[]
  written?: string[]
  download_name?: string
  failure_log?: string
}

// ---------------------------------------------------------------------------
// Background-job result envelopes and scheduler settings. Stable JobSpec and
// history contracts live in domain/jobs; only legacy event/result seams remain.

export interface JobHistoryStateDetail {
  jobs: JobHistoryRecord[]
  loading: boolean
  error: string | null
}

export type JobHistoryCommandDetail =
  | { command: 'refresh' }
  | { command: 'copy-config'; jobId: string }
  | { command: 'copy-cli'; jobId: string }
  | { command: 'download-config'; jobId: string }
  | { command: 'download'; jobId: string; filename?: string }

export interface JobResult {
  motion?: MotionPayload
  payload?: MotionPayload
  preview?: MotionPayload
  trajectory?: RobotTrajectoryPayload
  robot_trajectory?: RobotTrajectoryPayload
  scaled_scene?: ScenePayload
  token?: string
  export_token?: string
  artifact_path?: string
  download_name?: string
  written?: string[]
  failures?: Array<Record<string, unknown>>
  clips?: DatasetClip[]
  summary?: DatasetSummary
  meta?: {
    source_root?: string
    embedding?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface JobResponse {
  id: string
  kind: string
  status: JobStatus
  progress: number
  clip_progress?: number
  message?: string
  result?: JobResult | null
  error?: string | null
  created_at?: number
  finished_at?: number | null
  duration_seconds?: number
  parameters?: Record<string, JobParameterValue>
  result_summary?: Record<string, JobParameterValue>
  can_download?: boolean
}

export interface JobAdmissionSettings {
  max_running_jobs: number
  max_queued_jobs: number
}

export interface JobAdmissionSnapshot extends JobAdmissionSettings {
  running_jobs: number
  queued_jobs: number
  reserved_jobs: number
  /** Whether this client satisfies the backend's local-admin boundary. */
  editable?: boolean
}

export interface MotionLibrarySettingsSnapshot {
  root: string
  default_root: string
  editable: boolean
  /** Optional server hint explaining why an otherwise valid root is read-only. */
  readonly_reason?: string | null
  /** Optional origin of the effective value, for example default/settings/environment. */
  source?: string | null
}

/** Base GVHMR paths; capability fields augment this shape near the API map below. */
export interface GvhmrRuntimeStatus {
  ready: boolean
  missing: string[]
  root: string
  body_models_root: string
  image: string
}

export interface HealthResponse {
  ok: boolean
  ui_build?: string
  job_scheduler?: JobAdmissionSnapshot
  source_root?: string
  save_dir?: string
  motions_library_root?: string
  ui_features?: {
    merged_robot_panel?: boolean
    view_hud?: boolean
    scaled_skeleton_toggle?: boolean
    recalib_button?: boolean
  }
}

export interface ScaledPreviewResponse {
  preview: MotionPayload
  scaled_scene?: ScenePayload
}

// ---------------------------------------------------------------------------
// Dataset-analysis payloads and export metadata.

export interface DatasetMetricSummary {
  min?: number
  max?: number
  mean?: number
  median?: number
  lo?: number
  hi?: number
  [key: string]: number | undefined
}

export interface DatasetClip {
  clip_id: string
  source_path?: string
  source_kind?: 'human' | 'robot' | string
  folder_label?: string
  cluster_id?: string | number
  tags?: string[]
  metrics?: Record<string, number | string | boolean | null | undefined>
  embedding?: number[]
  scatter?: [number, number]
  error?: string
  dataset?: string
  stem?: string
  reference?: string
  upload_profile?: string
  export_subdir?: string
}

export interface HistogramData {
  edges: number[]
  counts: number[]
  min: number
  max: number
  mean: number
  median: number
}

export interface DatasetSummary {
  num_ok: number
  numeric_keys: string[]
  tag_counts: Record<string, number>
  histograms: Record<string, HistogramData>
}

export interface DatasetCatalogEntry {
  title?: string
  desc?: string
  detail?: string
  formula?: string
  unit?: string
  [key: string]: unknown
}

export interface DatasetAnalysisResult {
  clips: DatasetClip[]
  source_root?: string
  folder_label?: string
  numeric_keys?: string[]
  metrics?: Record<string, DatasetMetricSummary>
  categories?: Record<string, Record<string, number>>
  histograms?: Record<string, HistogramData>
  clustering?: {
    colors?: Record<string, string>
    [key: string]: unknown
  }
  tags?: Record<string, number>
  summary?: DatasetSummary
  meta?: {
    source_root?: string
    embedding?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface DatasetCatalog {
  tags?: Record<string, DatasetCatalogEntry>
  metrics?: Record<string, DatasetCatalogEntry>
  categories?: Record<string, DatasetCatalogEntry>
  clustering?: DatasetCatalogEntry & {
    handcrafted_inputs?: string
    algorithm?: string
  }
  [key: string]: unknown
}

export interface DatasetUploadSummary {
  source?: string
  source_root?: string
  folder_label?: string
  folders?: Record<string, unknown>
  files?: Array<{ name?: string; path?: string; folder_label?: string }>
  clips?: DatasetClip[]
  count?: number
  clip_count?: number
  robot_count?: number
  human_count?: number
  user_source_root?: string
  [key: string]: unknown
}

export interface BasketResponse {
  basket: LibraryEntry[]
}

export interface BasicResponse {
  ok?: boolean
  path?: string
  deleted?: string
  removed?: string
  motions_library_root?: string
  folder_label?: string
  clip_count?: number
  [key: string]: unknown
}

/**
 * Additional GVHMR capability fields. TypeScript declaration merging combines
 * this block with the base path fields above into one response contract.
 */
export interface GvhmrRuntimeStatus {
  ready: boolean
  missing: string[]
  checks: Record<string, boolean>
  root: string
  body_models_root: string
  image: string
  uses_official_weights: boolean
  supports_custom_weights: boolean
  training_enabled: boolean
}

// ---------------------------------------------------------------------------
// Typed HTTP route maps and the deliberately narrow cross-module bridge.

/**
 * Infer the response shape for known GET routes; unknown routes stay generic.
 * This is compile-time guidance only and does not validate JSON at runtime.
 */
export type ApiGetResponse<Url extends string> =
  Url extends '/api/health' ? HealthResponse
    : Url extends '/api/video-to-motion/status' ? GvhmrRuntimeStatus
    : Url extends '/api/settings/job-admission' ? JobAdmissionSnapshot
    : Url extends '/api/settings/motion-library' ? MotionLibrarySettingsSnapshot
    : Url extends '/api/library' ? LibraryResponse
      : Url extends '/api/robots' ? RobotsResponse
        : Url extends '/api/calibration/references' ? { references: string[] }
          : Url extends `/api/calibration/status${string}` ? CalibrationStatus
            : Url extends `/api/r2r/calibration/status${string}` ? CalibrationStatus
              : Url extends '/api/jobs' ? JobListResponse
                : Url extends `/api/job/${string}/config` ? JobConfigResponse
                  : Url extends `/api/job/${string}/cli` ? JobCliResponse
                    : Url extends `/api/job/${string}` ? JobResponse
                    : Url extends '/api/basket' ? BasketResponse
                      : Url extends '/api/dataset/catalog' ? DatasetCatalog
                        : Record<string, unknown>

export type ApiPostResponse<Url extends string> =
  Url extends '/api/robot/select' ? RobotPayload
    : Url extends '/api/robot/fk_preview' ? FkPreviewResponse
      : Url extends '/api/calibration/session' ? CalibrationSession
        : Url extends '/api/r2r/calibration/session' ? CalibrationSession
          : Url extends '/api/scaled_preview' ? ScaledPreviewResponse
            : Url extends '/api/motion/load_library' ? JobStartResponse
              : Url extends '/api/r2r/source/library' ? JobStartResponse
              : Url extends '/api/dataset/preview_robot' ? JobStartResponse
                : Url extends '/api/dataset/analyze' ? JobStartResponse
                  : Url extends '/api/retarget' ? JobStartResponse
                    : Url extends '/api/batch/retarget' ? JobStartResponse
                      : Url extends '/api/r2r/retarget' ? JobStartResponse
                    : Url extends '/api/r2r/batch/retarget' ? JobStartResponse
                      : Url extends '/api/jobs/spec/validate' ? JobSpecValidationResponse
                        : Url extends '/api/jobs/replay' ? JobReplayResponse
                          : Url extends '/api/basket/add' ? BasketResponse
                            : Url extends '/api/basket/clear' ? BasketResponse
                              : Url extends '/api/library/link' ? BasicResponse
                                : Url extends '/api/dataset/upload/remove' ? DatasetUploadSummary
                                  : BasicResponse

export interface UploadOptions {
  profile?: string
  name?: string
}

export interface ApiClient {
  get<Url extends string>(url: Url): Promise<ApiGetResponse<Url>>
  post<Url extends string>(url: Url, body?: unknown): Promise<ApiPostResponse<Url>>
  upload<Url extends string>(
    url: Url,
    files: Iterable<UploadFile>,
    options?: UploadOptions,
  ): Promise<Url extends '/api/robot/upload' ? RobotPayload : Record<string, unknown>>
  delete<Url extends string>(url: Url): Promise<BasicResponse>
}

export type ApiUploadResponse<Url extends string> =
  Url extends '/api/robot/upload' ? RobotPayload : Record<string, unknown>

export interface UploadFile extends File {
  _relpath?: string
}

export interface HhAppBridge {
  API: ApiClient
  toast: (message: string, isError?: boolean) => void
  loadLibraryEntry: (entry: LibraryEntry) => Promise<void>
  loadHumanMotionEntry: (entry: LibraryEntry) => Promise<void>
  loadR2rLibraryEntry: (entry: LibraryEntry) => Promise<void>
  pickR2rTrajectory: (options?: { folder?: boolean }) => Promise<void>
  previewRobotClip: (
    entry: LibraryEntry,
    robotName?: string,
  ) => Promise<RobotExportPreviewResult>
  populateDvRobotSelect: (preferred?: string) => Promise<string>
  addToBasket: (entries: LibraryEntry[], options?: { silent?: boolean }) => void
  switchInspectorPanel: (panelId: string) => void
  getLibrarySourceRoot: () => string
  refreshLibrary: () => Promise<void>
  pickFiles: (options?: { folder?: boolean; accept?: string }) => Promise<UploadFile[]>
  collectDroppedFiles: (dataTransfer: DataTransfer | null) => Promise<UploadFile[]>
  waitMotionJob: <Result = JobResult>(
    jobId: string,
    onProgress?: (fraction: number, message: string) => void,
    options?: { uploadFrac?: number },
  ) => Promise<Result>
  uploadFilesXHR: <Url extends string>(
    url: Url,
    files: Iterable<UploadFile>,
    options?: {
      profile?: string
      appendTo?: string
      libraryFolderLabel?: string
      userSourceRoot?: string
    },
    onProgress?: (progress: number | null, loaded: number, total: number) => void,
  ) => Promise<
    Url extends '/api/dataset/upload'
      ? DatasetUploadSummary
      : Url extends `${string}upload${string}`
        ? JobStartResponse
        : Record<string, unknown>
  >
}

/** Common surface implemented by every object driven by the shared timeline. */
export interface PlaybackView {
  group: THREE.Group
  joints?: unknown[] | null
  trajectory?: RobotTrajectoryPayload | null
  numFrames: number
  clipDuration?: number | null
  heavy?: boolean
  setFrame(frame: number): void
  setFrameFrac?(frame: number): void
}
