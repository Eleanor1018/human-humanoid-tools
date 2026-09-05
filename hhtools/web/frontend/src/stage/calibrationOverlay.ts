import * as THREE from "three";

import type { ReferenceJointMapping } from "./referenceSkeleton";

const REFERENCE_LABELS: Readonly<Record<string, string>> = {
  hips: "Hips",
  chest: "Chest",
  neck: "Neck",
  head: "Head",
  lefthip: "Left hip",
  righthip: "Right hip",
  leftknee: "Left knee",
  rightknee: "Right knee",
  leftankle: "Left ankle",
  rightankle: "Right ankle",
  leftshoulder: "Left shoulder",
  rightshoulder: "Right shoulder",
  leftelbow: "Left elbow",
  rightelbow: "Right elbow",
  leftwrist: "Left wrist",
  rightwrist: "Right wrist",
};

export interface CalibrationMappingProjection {
  readonly key: string;
  readonly referenceX: number;
  readonly referenceY: number;
  readonly targetX: number;
  readonly targetY: number;
}

export interface ProjectedEndpoints {
  readonly referenceX: number;
  readonly referenceY: number;
  readonly targetX: number;
  readonly targetY: number;
}

function normalizedSemantic(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function calibrationMappingKey(mapping: ReferenceJointMapping): string {
  return `${mapping.index}\u0000${mapping.semantic}\u0000${mapping.targetLink}`;
}

export function calibrationMappingLabel(mapping: ReferenceJointMapping): string {
  const semantic = REFERENCE_LABELS[normalizedSemantic(mapping.semantic)]
    ?? mapping.semantic.replaceAll("_", " ");
  return `${semantic} · ${mapping.targetLink}`;
}

/** Project two world-space points onto the CSS-pixel Stage overlay. */
export function projectCalibrationEndpoints(
  referenceWorld: THREE.Vector3,
  targetWorld: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number,
): ProjectedEndpoints | null {
  referenceWorld.project(camera);
  targetWorld.project(camera);
  const inFrustum =
    referenceWorld.z >= -1 &&
    referenceWorld.z <= 1 &&
    targetWorld.z >= -1 &&
    targetWorld.z <= 1;
  if (!inFrustum || width <= 0 || height <= 0) return null;
  return {
    referenceX: (referenceWorld.x * 0.5 + 0.5) * width,
    referenceY: (-referenceWorld.y * 0.5 + 0.5) * height,
    targetX: (targetWorld.x * 0.5 + 0.5) * width,
    targetY: (-targetWorld.y * 0.5 + 0.5) * height,
  };
}

