/**
 * Stable motion and scene contracts shared across renderer entry points.
 *
 * These shapes mirror FastAPI payloads, so snake_case field names are
 * intentional. This module contains data only and must stay independent from
 * React, browser APIs, transports, and the compatibility runtime.
 */

export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];

export interface TerrainPayload {
  vertices: Vec3[];
  faces: [number, number, number][];
}

export interface SceneObjectPayload {
  color?: [number, number, number];
  extents: Vec3;
  opacity?: number;
  positions: Vec3[];
  quaternions: Quaternion[];
  has_mesh?: boolean;
  source_index?: number;
  scale?: number;
  mesh_file?: string;
}

export interface ScenePayload {
  terrain?: TerrainPayload | null;
  objects?: SceneObjectPayload[];
}

export interface BodyMeshPayload {
  available: boolean;
  vertices_gz_b64: string;
  num_verts: number;
  num_frames: number;
  triangles: [number, number, number][];
  reason?: string;
}

export type MotionCategory = "motion" | "object" | "terrain";

/**
 * Pipeline-level meaning of a library item.
 *
 * A human motion is a skeleton/body-space reference consumed by H2R. A robot
 * trajectory contains root pose plus source-robot DoF samples and is consumed
 * by R2R. Keeping this separate from `motion_category` prevents a visually
 * similar clip from crossing workflow boundaries.
 */
export type LibraryAssetKind = "human_motion" | "robot_trajectory";

export interface LibraryEntry {
  dataset?: string;
  folder_label?: string;
  sequence_id?: string;
  stem?: string;
  source_path: string;
  label?: string;
  name?: string;
  display_name?: string;
  origin?: string;
  reference?: string;
  upload_profile?: string;
  export_subdir?: string;
  token?: string;
  suggested_backend?: string;
  /** Stable backend-provided UX category; never infer it from dataset labels. */
  motion_category?: MotionCategory;
  /** Stable backend-provided pipeline boundary. */
  asset_kind?: LibraryAssetKind;
}

/** Complete human-motion payload returned by upload and generation jobs. */
export interface MotionPayload extends ScenePayload {
  name: string;
  token: string;
  positions: Vec3[][];
  parent_indices: number[];
  exclude_joint_indices?: number[];
  frame_indices?: number[];
  playback_frames?: number;
  playback_duration?: number;
  num_frames_total?: number;
  duration?: number;
  framerate?: number;
  sample_rate?: number;
  source_format?: string;
  bone_names?: string[];
  dataset?: string;
  suggested_reference?: string;
  suggested_backend?: string;
  has_terrain?: boolean;
  body_mesh?: BodyMeshPayload;
  library_entry?: LibraryEntry;
  linked_folder?: string;
  materialize_mode?: "symlink" | "hardlink" | "copy" | string;
  meta?: Record<string, unknown>;
}
