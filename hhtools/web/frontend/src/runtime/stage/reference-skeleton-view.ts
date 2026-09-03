import * as THREE from "three";

import type { ThreeResourceDisposer } from "@/platform/graphics/common/three-resource-disposer";
import type { CalibrationReferencePayload } from "../types";

/** Minimal read port required for reference-to-robot diagnostics and overlays. */
export interface ReferenceSkeletonRobotView {
  getLinkWorldPosition(link: string, out: THREE.Vector3): boolean;
  getLinkWorldQuaternion(link: string, out: THREE.Quaternion): boolean;
}

export interface ReferenceLandmarkMapping {
  semantic: string;
  targetLink: string;
  index: number;
  label: HTMLElement;
  line: SVGLineElement;
}

export interface ReferenceAlignmentDiagnostic {
  semantic: string;
  targetLink: string;
  positionResidualM: number;
  verticalResidualM: number;
  rotationResidualDeg: number | null;
}

export type ReferenceSkeletonLocalize = (
  english: string,
  chinese: string,
) => string;

export interface ReferenceSkeletonViewOptions {
  readonly labelRoot: HTMLElement;
  readonly lineRoot: SVGSVGElement;
  readonly camera: THREE.Camera;
  readonly localize: ReferenceSkeletonLocalize;
  readonly resourceDisposer: ThreeResourceDisposer;
}

const CANONICAL_LANDMARK_LABELS: Record<string, readonly [string, string]> = {
  hips: ["Hips", "髋部"],
  chest: ["Chest", "胸部"],
  neck: ["Neck", "颈部"],
  head: ["Head", "头部"],
  left_hip: ["Left hip", "左髋"],
  right_hip: ["Right hip", "右髋"],
  left_knee: ["Left knee", "左膝"],
  right_knee: ["Right knee", "右膝"],
  left_ankle: ["Left ankle", "左踝"],
  right_ankle: ["Right ankle", "右踝"],
  left_shoulder: ["Left shoulder", "左肩"],
  right_shoulder: ["Right shoulder", "右肩"],
  left_elbow: ["Left elbow", "左肘"],
  right_elbow: ["Right elbow", "右肘"],
  left_wrist: ["Left wrist", "左腕"],
  right_wrist: ["Right wrist", "右腕"],
};

export function normalizedSemanticName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function ikMapTargetLink(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  for (const key of ["t_body", "link", "body", "target"]) {
    if (typeof candidate[key] === "string") return candidate[key] as string;
  }
  return null;
}

/**
 * Blue reference T-pose shown during calibration.
 *
 * Construction is inert: the compatibility composition root owns the stable
 * Three.js Group, while DOM hosts, camera, localization, and disposal policy
 * are explicit dependencies. Session-scoped ownership is intentionally left
 * to the next migration slice; this extraction preserves the legacy API.
 */
export class ReferenceSkeletonView {
  readonly group = new THREE.Group();
  readonly labelRoot: HTMLElement;
  readonly lineRoot: SVGSVGElement;
  spheres: Array<THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>> = [];
  parents: number[] = [];
  boneNames: string[] = [];
  canonicalNames: string[] = [];
  referenceQuaternions: Array<[number, number, number, number]> = [];
  exclude = new Set<number>();
  mappings: ReferenceLandmarkMapping[] = [];
  lineGeom: THREE.BufferGeometry | null = null;
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  mappedMaterial: THREE.MeshStandardMaterial | null = null;
  contextMaterial: THREE.MeshStandardMaterial | null = null;
  mappedOnly = true;
  labelsVisible = true;
  mappingLinesVisible = true;
  sourceOpacity = 0.82;

  readonly #camera: THREE.Camera;
  readonly #localize: ReferenceSkeletonLocalize;
  readonly #resourceDisposer: ThreeResourceDisposer;

  constructor({
    labelRoot,
    lineRoot,
    camera,
    localize,
    resourceDisposer,
  }: ReferenceSkeletonViewOptions) {
    this.group.visible = false;
    this.labelRoot = labelRoot;
    this.lineRoot = lineRoot;
    this.#camera = camera;
    this.#localize = localize;
    this.#resourceDisposer = resourceDisposer;
  }

  clear(): void {
    try {
      this.#resourceDisposer.disposeObject3DChildren(this.group, {
        geometries: [
          ...this.spheres.map((sphere) => sphere.geometry),
          ...(this.lineGeom ? [this.lineGeom] : []),
        ],
        materials: [
          ...this.spheres.map((sphere) => sphere.material),
          ...(this.lines ? [this.lines.material] : []),
          ...(this.mappedMaterial ? [this.mappedMaterial] : []),
          ...(this.contextMaterial ? [this.contextMaterial] : []),
        ],
      });
    } finally {
      // DOM overlays and aliases describe the same resource generation as the
      // Group, so a failed disposer must not leave either generation reachable.
      try {
        this.group.clear();
      } finally {
        try {
          this.labelRoot.replaceChildren();
        } finally {
          try {
            this.lineRoot.replaceChildren();
          } finally {
            this.spheres = [];
            this.parents = [];
            this.boneNames = [];
            this.canonicalNames = [];
            this.referenceQuaternions = [];
            this.exclude = new Set();
            this.mappings = [];
            this.lineGeom = null;
            this.lines = null;
            this.mappedMaterial = null;
            this.contextMaterial = null;
            this.group.visible = false;
          }
        }
      }
    }
  }

  load(ref: CalibrationReferencePayload | null | undefined): void {
    this.clear();
    if (!ref?.positions?.length) return;
    const color = ref.color != null ? ref.color : 0x5eb3ff;
    const fr = ref.positions[0];
    this.parents = ref.parent_indices;
    this.boneNames = ref.bone_names?.slice()
      ?? this.parents.map((_, index) => `joint_${index}`);
    this.canonicalNames = ref.canonical_names?.slice() ?? this.boneNames.slice();
    this.referenceQuaternions = ref.quaternions?.[0]?.slice() ?? [];
    this.exclude = new Set(ref.exclude_joint_indices || []);
    const jointCount = this.parents.length;
    this.mappedMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.34,
      metalness: 0.03,
      emissive: 0x0a4d92,
      emissiveIntensity: 0.62,
      transparent: true,
      opacity: this.sourceOpacity,
    });
    this.contextMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.48,
      metalness: 0.02,
      emissive: 0x1a3a66,
      emissiveIntensity: 0.18,
      transparent: true,
      opacity: this.sourceOpacity * 0.32,
    });
    const sphereGeo = new THREE.SphereGeometry(0.022, 12, 12);
    for (let index = 0; index < jointCount; index++) {
      const sphere = new THREE.Mesh(sphereGeo, this.contextMaterial);
      if (this.exclude.has(index)) sphere.visible = false;
      this.group.add(sphere);
      this.spheres.push(sphere);
    }
    let segmentCount = 0;
    for (let index = 0; index < jointCount; index++) {
      const parent = this.parents[index];
      if (parent < 0 || this.exclude.has(index) || this.exclude.has(parent)) continue;
      segmentCount++;
    }
    const positions = new Float32Array(segmentCount * 2 * 3);
    this.lineGeom = new THREE.BufferGeometry();
    this.lineGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.lines = new THREE.LineSegments(
      this.lineGeom,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: this.sourceOpacity * 0.38,
      }),
    );
    this.group.add(this.lines);
    for (let index = 0; index < jointCount; index++) {
      if (this.exclude.has(index)) continue;
      this.spheres[index].position.set(fr[index][0], fr[index][1], fr[index][2]);
    }
    const position = this.lineGeom.getAttribute("position") as THREE.BufferAttribute;
    const array = position.array;
    let offset = 0;
    for (let index = 0; index < jointCount; index++) {
      const parent = this.parents[index];
      if (parent < 0 || this.exclude.has(index) || this.exclude.has(parent)) continue;
      array[offset++] = fr[index][0];
      array[offset++] = fr[index][1];
      array[offset++] = fr[index][2];
      array[offset++] = fr[parent][0];
      array[offset++] = fr[parent][1];
      array[offset++] = fr[parent][2];
    }
    position.needsUpdate = true;
    this.group.visible = true;
    this.applyDisplayOptions();
  }

  configureMappings(ikMap: Record<string, unknown> | null | undefined): number {
    this.labelRoot.replaceChildren();
    this.lineRoot.replaceChildren();
    this.mappings = [];
    const canonicalIndex = new Map<string, number>();
    this.canonicalNames.forEach((name, index) => {
      canonicalIndex.set(normalizedSemanticName(name), index);
    });
    this.boneNames.forEach((name, index) => {
      const key = normalizedSemanticName(name);
      if (!canonicalIndex.has(key)) canonicalIndex.set(key, index);
    });

    for (const [semantic, rawTarget] of Object.entries(ikMap ?? {})) {
      const targetLink = ikMapTargetLink(rawTarget);
      const index = canonicalIndex.get(normalizedSemanticName(semantic));
      if (!targetLink || index == null || this.exclude.has(index)) continue;

      const document = this.labelRoot.ownerDocument;
      const label = document.createElement("span");
      label.className = "calib-landmark-label";
      const primary = document.createElement("strong");
      const labels = CANONICAL_LANDMARK_LABELS[semantic];
      primary.textContent = labels
        ? this.#localize(labels[0], labels[1])
        : semantic.replaceAll("_", " ");
      label.append(primary, document.createTextNode(` · ${targetLink}`));
      this.labelRoot.appendChild(label);

      const line = this.lineRoot.ownerDocument.createElementNS(
        "http://www.w3.org/2000/svg",
        "line",
      );
      this.lineRoot.appendChild(line);
      this.mappings.push({ semantic, targetLink, index, label, line });
    }
    this.applyDisplayOptions();
    return this.mappings.length;
  }

  setDisplayOptions({
    mappedOnly,
    labels,
    mappingLines,
    sourceOpacity,
  }: {
    mappedOnly?: boolean;
    labels?: boolean;
    mappingLines?: boolean;
    sourceOpacity?: number;
  }): void {
    if (mappedOnly != null) this.mappedOnly = mappedOnly;
    if (labels != null) this.labelsVisible = labels;
    if (mappingLines != null) this.mappingLinesVisible = mappingLines;
    if (sourceOpacity != null) {
      this.sourceOpacity = Math.min(1, Math.max(0.1, sourceOpacity));
    }
    this.applyDisplayOptions();
  }

  private applyDisplayOptions(): void {
    const mappedIndices = new Set(this.mappings.map((mapping) => mapping.index));
    this.spheres.forEach((sphere, index) => {
      const mapped = mappedIndices.has(index);
      sphere.material = mapped && this.mappedMaterial
        ? this.mappedMaterial
        : this.contextMaterial ?? sphere.material;
      sphere.scale.setScalar(mapped ? 1.12 : 0.62);
      sphere.visible = !this.exclude.has(index) && (mapped || !this.mappedOnly);
    });
    if (this.mappedMaterial) this.mappedMaterial.opacity = this.sourceOpacity;
    if (this.contextMaterial) this.contextMaterial.opacity = this.sourceOpacity * 0.32;
    if (this.lines) this.lines.material.opacity = this.sourceOpacity * 0.38;
    this.labelRoot.style.display = this.labelsVisible ? "block" : "none";
    this.lineRoot.style.display = this.mappingLinesVisible ? "block" : "none";
  }

  updateOverlay(robotView: ReferenceSkeletonRobotView): void {
    const active = this.group.visible && this.mappings.length > 0;
    const width = this.labelRoot.clientWidth;
    const height = this.labelRoot.clientHeight;
    if (!active || width <= 0 || height <= 0) {
      for (const mapping of this.mappings) {
        mapping.label.style.display = "none";
        mapping.line.style.display = "none";
      }
      return;
    }

    const referencePoint = new THREE.Vector3();
    const targetPoint = new THREE.Vector3();
    for (const mapping of this.mappings) {
      this.spheres[mapping.index].getWorldPosition(referencePoint);
      if (!robotView.getLinkWorldPosition(mapping.targetLink, targetPoint)) {
        mapping.label.style.display = "none";
        mapping.line.style.display = "none";
        continue;
      }
      const referenceNdc = referencePoint.clone().project(this.#camera);
      const targetNdc = targetPoint.clone().project(this.#camera);
      const visible = referenceNdc.z >= -1 && referenceNdc.z <= 1
        && targetNdc.z >= -1 && targetNdc.z <= 1;
      if (!visible) {
        mapping.label.style.display = "none";
        mapping.line.style.display = "none";
        continue;
      }
      const rx = (referenceNdc.x * 0.5 + 0.5) * width;
      const ry = (-referenceNdc.y * 0.5 + 0.5) * height;
      const tx = (targetNdc.x * 0.5 + 0.5) * width;
      const ty = (-targetNdc.y * 0.5 + 0.5) * height;
      mapping.label.style.display = this.labelsVisible ? "block" : "none";
      mapping.label.style.left = `${rx}px`;
      mapping.label.style.top = `${ry}px`;
      mapping.line.style.display = this.mappingLinesVisible ? "block" : "none";
      mapping.line.setAttribute("x1", String(rx));
      mapping.line.setAttribute("y1", String(ry));
      mapping.line.setAttribute("x2", String(tx));
      mapping.line.setAttribute("y2", String(ty));
    }
  }

  alignmentDiagnostics(
    robotView: ReferenceSkeletonRobotView,
  ): ReferenceAlignmentDiagnostic[] {
    const referencePosition = new THREE.Vector3();
    const targetPosition = new THREE.Vector3();
    const targetQuaternion = new THREE.Quaternion();
    const worldQuaternion = new THREE.Quaternion();
    // The stable Group is composed directly under the former global `world`.
    // Reading its parent keeps the extracted View inert without changing the
    // reference-quaternion frame used by the compatibility renderer.
    this.group.parent?.getWorldQuaternion(worldQuaternion);
    return this.mappings.flatMap((mapping) => {
      this.spheres[mapping.index].getWorldPosition(referencePosition);
      if (!robotView.getLinkWorldPosition(mapping.targetLink, targetPosition)) return [];
      let rotationResidualDeg: number | null = null;
      const rawQuaternion = this.referenceQuaternions[mapping.index];
      if (
        rawQuaternion
        && robotView.getLinkWorldQuaternion(mapping.targetLink, targetQuaternion)
      ) {
        const referenceQuaternion = worldQuaternion.clone().multiply(
          new THREE.Quaternion(
            rawQuaternion[0],
            rawQuaternion[1],
            rawQuaternion[2],
            rawQuaternion[3],
          ),
        );
        const dot = Math.min(1, Math.abs(referenceQuaternion.dot(targetQuaternion)));
        rotationResidualDeg = 2 * Math.acos(dot) * 180 / Math.PI;
      }
      return [{
        semantic: mapping.semantic,
        targetLink: mapping.targetLink,
        positionResidualM: referencePosition.distanceTo(targetPosition),
        verticalResidualM: Math.abs(referencePosition.z - targetPosition.z),
        rotationResidualDeg,
      }];
    });
  }

  headingResidualDeg(robotView: ReferenceSkeletonRobotView): number | null {
    const findMapping = (semantic: string) => this.mappings.find(
      (mapping) => (
        normalizedSemanticName(mapping.semantic) === normalizedSemanticName(semantic)
      ),
    );
    const candidates: Array<readonly [string, string]> = [
      ["left_shoulder", "right_shoulder"],
      ["left_hip", "right_hip"],
    ];
    const refLeft = new THREE.Vector3();
    const refRight = new THREE.Vector3();
    const targetLeft = new THREE.Vector3();
    const targetRight = new THREE.Vector3();
    for (const [leftName, rightName] of candidates) {
      const left = findMapping(leftName);
      const right = findMapping(rightName);
      if (!left || !right) continue;
      this.spheres[left.index].getWorldPosition(refLeft);
      this.spheres[right.index].getWorldPosition(refRight);
      if (!robotView.getLinkWorldPosition(left.targetLink, targetLeft)) continue;
      if (!robotView.getLinkWorldPosition(right.targetLink, targetRight)) continue;
      const referenceAxis = refRight.clone().sub(refLeft).setZ(0);
      const targetAxis = targetRight.clone().sub(targetLeft).setZ(0);
      if (referenceAxis.lengthSq() < 1e-8 || targetAxis.lengthSq() < 1e-8) continue;
      return referenceAxis.angleTo(targetAxis) * 180 / Math.PI;
    }
    return null;
  }
}
