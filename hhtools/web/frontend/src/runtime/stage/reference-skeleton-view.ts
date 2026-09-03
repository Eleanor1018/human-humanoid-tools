import * as THREE from "three";

import type {
  ThreeResourceDisposer,
  ThreeResourceExtras,
} from "@/platform/graphics/common/three-resource-disposer";
import type { CalibrationReferencePayload } from "../types";
import {
  installReentrantSessionResource,
  type SessionInstallAuthority,
  type SessionInstallDisposition,
} from "./reentrant-session-install";

/** Minimal read port required for reference-to-robot diagnostics and overlays. */
export interface ReferenceSkeletonRobotView {
  getLinkWorldPosition(link: string, out: THREE.Vector3): boolean;
  getLinkWorldQuaternion(link: string, out: THREE.Quaternion): boolean;
}

export interface ReferenceAlignmentDiagnostic {
  readonly semantic: string;
  readonly targetLink: string;
  readonly positionResidualM: number;
  readonly verticalResidualM: number;
  readonly rotationResidualDeg: number | null;
}

export interface ReferenceSkeletonDiagnosticsSnapshot {
  readonly alignment: readonly ReferenceAlignmentDiagnostic[];
  readonly headingResidualDeg: number | null;
}

export interface ReferenceSkeletonDisplayOptions {
  readonly mappedOnly?: boolean;
  readonly labels?: boolean;
  readonly mappingLines?: boolean;
  readonly sourceOpacity?: number;
}

export interface ReferenceSkeletonSetup {
  readonly payload: CalibrationReferencePayload | null | undefined;
  readonly ikMap: Readonly<Record<string, unknown>> | null | undefined;
  readonly display?: ReferenceSkeletonDisplayOptions;
}

interface PreparedReferenceMapping {
  readonly semantic: string;
  readonly targetLink: string;
  readonly index: number;
}

/** Pure, validated input which can safely be created before lease publication. */
export interface PreparedReferenceSkeleton {
  readonly positions: readonly (readonly [number, number, number])[];
  readonly parents: readonly number[];
  readonly boneNames: readonly string[];
  readonly canonicalNames: readonly string[];
  readonly quaternions: readonly (readonly [number, number, number, number])[];
  readonly excluded: ReadonlySet<number>;
  readonly mappings: readonly PreparedReferenceMapping[];
  readonly color: number;
  readonly display: Readonly<Required<ReferenceSkeletonDisplayOptions>>;
}

declare const referenceSkeletonResourceBrand: unique symbol;

/** Opaque generation handle. Temporal authority remains the caller's session lease. */
export interface ReferenceSkeletonResource {
  readonly [referenceSkeletonResourceBrand]: true;
}

export interface ReferenceSkeletonFacts {
  readonly object: THREE.Group;
  readonly available: boolean;
  readonly visible: boolean;
  readonly mappedLandmarks: number;
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

export interface ReferenceSkeletonInstallOptions {
  readonly prepared: PreparedReferenceSkeleton;
  readonly authority: SessionInstallAuthority;
  /** Publish the exact cleanup obligation before the first host attachment. */
  readonly mark: (resource: ReferenceSkeletonResource) => void;
}

interface ReferenceLandmarkMapping extends PreparedReferenceMapping {
  readonly label: HTMLElement;
  readonly primary: HTMLElement;
  readonly line: SVGLineElement;
}

interface ReferenceSkeletonRecord {
  readonly root: THREE.Group;
  readonly labelLayer: HTMLElement;
  readonly lineLayer: SVGGElement;
  readonly spheres: Array<
    THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  >;
  readonly mappings: ReferenceLandmarkMapping[];
  readonly quaternions: readonly (readonly [number, number, number, number])[];
  readonly excluded: ReadonlySet<number>;
  readonly mappedMaterial: THREE.MeshStandardMaterial | null;
  readonly contextMaterial: THREE.MeshStandardMaterial | null;
  readonly lines: THREE.LineSegments<
    THREE.BufferGeometry,
    THREE.LineBasicMaterial
  > | null;
  readonly extras: ThreeResourceExtras;
  display: Required<ReferenceSkeletonDisplayOptions>;
  projectedVisible: boolean;
  disposed: boolean;
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

const DEFAULT_DISPLAY: Required<ReferenceSkeletonDisplayOptions> = {
  mappedOnly: true,
  labels: true,
  mappingLines: true,
  sourceOpacity: 0.82,
};

function appendReferenceError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendReferenceError(errors, nested);
    return;
  }
  errors.push(error);
}

function throwReferenceErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function finiteNumber(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${description} must be a finite number`);
  }
  return value;
}

function copyVec3(value: unknown, description: string): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) {
    throw new TypeError(`${description} must contain three coordinates`);
  }
  return Object.freeze([
    finiteNumber(value[0], `${description}[0]`),
    finiteNumber(value[1], `${description}[1]`),
    finiteNumber(value[2], `${description}[2]`),
  ] as [number, number, number]);
}

function copyQuaternion(
  value: unknown,
  description: string,
): readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length < 4) {
    throw new TypeError(`${description} must contain four coordinates`);
  }
  return Object.freeze([
    finiteNumber(value[0], `${description}[0]`),
    finiteNumber(value[1], `${description}[1]`),
    finiteNumber(value[2], `${description}[2]`),
    finiteNumber(value[3], `${description}[3]`),
  ] as [number, number, number, number]);
}

function normalizedDisplayOptions(
  value: ReferenceSkeletonDisplayOptions | undefined,
): Required<ReferenceSkeletonDisplayOptions> {
  const opacity = value?.sourceOpacity ?? DEFAULT_DISPLAY.sourceOpacity;
  if (!Number.isFinite(opacity)) {
    throw new TypeError("Reference source opacity must be finite");
  }
  return Object.freeze({
    mappedOnly: value?.mappedOnly ?? DEFAULT_DISPLAY.mappedOnly,
    labels: value?.labels ?? DEFAULT_DISPLAY.labels,
    mappingLines: value?.mappingLines ?? DEFAULT_DISPLAY.mappingLines,
    sourceOpacity: Math.min(1, Math.max(0.1, opacity)),
  });
}

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
 * Session-owned blue reference T-pose used by both calibration workflows.
 *
 * The stable `group` is the only composition-root object. Every visible Three
 * and DOM child belongs to an opaque resource generation supplied by the
 * outer calibration lease; this class deliberately has no independent owner.
 */
export class ReferenceSkeletonView {
  readonly group = new THREE.Group();

  readonly #labelRoot: HTMLElement;
  readonly #lineRoot: SVGSVGElement;
  readonly #camera: THREE.Camera;
  readonly #localize: ReferenceSkeletonLocalize;
  readonly #resourceDisposer: ThreeResourceDisposer;
  readonly #records = new WeakMap<ReferenceSkeletonResource, ReferenceSkeletonRecord>();

  constructor({
    labelRoot,
    lineRoot,
    camera,
    localize,
    resourceDisposer,
  }: ReferenceSkeletonViewOptions) {
    this.group.visible = false;
    this.#labelRoot = labelRoot;
    this.#lineRoot = lineRoot;
    this.#camera = camera;
    this.#localize = localize;
    this.#resourceDisposer = resourceDisposer;
  }

  /** Validate and copy all external data without invoking DOM or renderer code. */
  prepare({
    payload,
    ikMap,
    display,
  }: ReferenceSkeletonSetup): PreparedReferenceSkeleton {
    const normalizedDisplay = normalizedDisplayOptions(display);
    if (!payload?.positions?.length) {
      return Object.freeze({
        positions: Object.freeze([]),
        parents: Object.freeze([]),
        boneNames: Object.freeze([]),
        canonicalNames: Object.freeze([]),
        quaternions: Object.freeze([]),
        excluded: new Set<number>(),
        mappings: Object.freeze([]),
        color: 0x5eb3ff,
        display: normalizedDisplay,
      });
    }

    const parents = Object.freeze(payload.parent_indices.slice());
    const jointCount = parents.length;
    const frame = payload.positions[0];
    if (!Array.isArray(frame) || frame.length < jointCount) {
      throw new RangeError("Reference frame does not cover every parent index");
    }
    const positions = Object.freeze(parents.map((_, index) => (
      copyVec3(frame[index], `Reference position ${index}`)
    )));
    parents.forEach((parent, index) => {
      if (!Number.isInteger(parent) || parent < -1 || parent >= jointCount) {
        throw new RangeError(`Reference parent ${index} is out of range`);
      }
      if (parent === index) {
        throw new RangeError(`Reference parent ${index} cannot point to itself`);
      }
    });

    const boneNames = Object.freeze(parents.map((_, index) => (
      String(payload.bone_names?.[index] ?? `joint_${index}`)
    )));
    const canonicalNames = Object.freeze(parents.map((_, index) => (
      String(payload.canonical_names?.[index] ?? boneNames[index])
    )));
    const rawQuaternions = payload.quaternions?.[0] ?? [];
    const quaternions = Object.freeze(rawQuaternions.slice(0, jointCount).map(
      (quaternion, index) => copyQuaternion(
        quaternion,
        `Reference quaternion ${index}`,
      ),
    ));
    const excludedValues = payload.exclude_joint_indices ?? [];
    const excluded = new Set<number>();
    excludedValues.forEach((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= jointCount) {
        throw new RangeError(`Excluded reference joint ${index} is out of range`);
      }
      excluded.add(index);
    });

    const canonicalIndex = new Map<string, number>();
    canonicalNames.forEach((name, index) => {
      canonicalIndex.set(normalizedSemanticName(name), index);
    });
    boneNames.forEach((name, index) => {
      const key = normalizedSemanticName(name);
      if (!canonicalIndex.has(key)) canonicalIndex.set(key, index);
    });
    const mappings: PreparedReferenceMapping[] = [];
    for (const [semantic, rawTarget] of Object.entries(ikMap ?? {})) {
      const targetLink = ikMapTargetLink(rawTarget);
      const index = canonicalIndex.get(normalizedSemanticName(semantic));
      if (!targetLink || index == null || excluded.has(index)) continue;
      mappings.push(Object.freeze({ semantic, targetLink, index }));
    }

    const color = payload.color == null
      ? 0x5eb3ff
      : finiteNumber(payload.color, "Reference color");
    return Object.freeze({
      positions,
      parents,
      boneNames,
      canonicalNames,
      quaternions,
      excluded,
      mappings: Object.freeze(mappings),
      color,
      display: normalizedDisplay,
    });
  }

  /** Build detached, publish the obligation, then attach each exact root. */
  install({
    prepared,
    authority,
    mark,
  }: ReferenceSkeletonInstallOptions): SessionInstallDisposition {
    if (!authority.isCurrent()) return "superseded";
    let record: ReferenceSkeletonRecord | null = null;
    let resource: ReferenceSkeletonResource | null = null;
    let published = false;
    try {
      record = this.#buildDetached(prepared, authority);
      if (!record || !authority.isCurrent()) {
        if (record) this.#disposeRecord(record);
        return "superseded";
      }
      resource = Object.freeze({}) as ReferenceSkeletonResource;
      this.#records.set(resource, record);

      const attach = (
        install: () => void,
        cleanupLate: () => void,
        publish = false,
      ): SessionInstallDisposition => installReentrantSessionResource({
        authority,
        mark: () => {
          if (!publish) return;
          published = true;
          mark(resource!);
        },
        install,
        cleanupLate,
      });

      let disposition = attach(
        () => { this.group.add(record!.root); },
        () => { this.group.remove(record!.root); },
        true,
      );
      if (disposition === "installed") {
        disposition = attach(
          () => { this.#labelRoot.appendChild(record!.labelLayer); },
          () => { record!.labelLayer.remove(); },
        );
      }
      if (disposition === "installed") {
        disposition = attach(
          () => { this.#lineRoot.appendChild(record!.lineLayer); },
          () => { record!.lineLayer.remove(); },
        );
      }
      if (disposition === "superseded") this.dispose(resource);
      return disposition;
    } catch (error) {
      const errors: unknown[] = [];
      appendReferenceError(errors, error);
      try {
        if (resource) this.dispose(resource);
        else if (record) this.#disposeRecord(record);
      } catch (cleanupError) {
        appendReferenceError(errors, cleanupError);
      }
      // `published` documents that lifecycle rollback owns the same handle;
      // dispose is exact/idempotent, so eager rollback cannot harm a successor.
      void published;
      throwReferenceErrors(
        errors,
        "Reference skeleton setup failed and rollback was incomplete",
      );
      return "superseded";
    }
  }

  /** Exact, idempotent terminal cleanup; every independent resource is tried. */
  dispose(resource: ReferenceSkeletonResource): void {
    const record = this.#records.get(resource);
    if (!record || record.disposed) return;
    this.#records.delete(resource);
    record.disposed = true;
    record.projectedVisible = false;

    const errors: unknown[] = [];
    const capture = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        appendReferenceError(errors, error);
      }
    };
    capture(() => { record.root.visible = false; });
    capture(() => { record.labelLayer.style.display = "none"; });
    capture(() => { record.lineLayer.style.display = "none"; });
    capture(() => { this.group.remove(record.root); });
    capture(() => { record.labelLayer.remove(); });
    capture(() => { record.lineLayer.remove(); });
    capture(() => this.#resourceDisposer.disposeObject3DResources(
      record.root,
      record.extras,
    ));
    capture(() => { record.root.clear(); });
    throwReferenceErrors(errors, "Reference skeleton cleanup failed");
  }

  /** Project shared visibility from the outer session selected by the caller. */
  project(
    resource: ReferenceSkeletonResource | null,
    visible: boolean,
    authority: SessionInstallAuthority,
  ): boolean {
    if (!authority.isCurrent()) return false;
    const record = resource ? this.#record(resource) : null;
    // A non-null missing handle is a retired generation, not an instruction to
    // hide the stable parent currently projected by a live successor.
    if (resource && !record) return false;
    const show = Boolean(record && visible && record.spheres.length > 0);
    if (record) {
      record.projectedVisible = show;
      record.root.visible = show;
      if (!authority.isCurrent()) return false;
      record.labelLayer.style.display = show && record.display.labels ? "contents" : "none";
      if (!authority.isCurrent()) return false;
      record.lineLayer.style.display = show && record.display.mappingLines ? "inline" : "none";
      if (!authority.isCurrent()) return false;
    }
    this.group.visible = show;
    return authority.isCurrent();
  }

  facts(resource: ReferenceSkeletonResource): ReferenceSkeletonFacts | null {
    const record = this.#record(resource);
    if (!record) return null;
    return Object.freeze({
      object: record.root,
      available: record.spheres.length > 0,
      visible: record.projectedVisible,
      mappedLandmarks: record.mappings.length,
    });
  }

  setDisplayOptions(
    resource: ReferenceSkeletonResource,
    patch: ReferenceSkeletonDisplayOptions,
    authority: SessionInstallAuthority,
  ): boolean {
    const record = this.#currentRecord(resource, authority);
    if (!record) return false;
    record.display = normalizedDisplayOptions({ ...record.display, ...patch });
    return this.#applyDisplay(record, authority);
  }

  refreshLabels(
    resource: ReferenceSkeletonResource,
    authority: SessionInstallAuthority,
  ): boolean {
    const record = this.#currentRecord(resource, authority);
    if (!record) return false;
    for (const mapping of record.mappings) {
      const labels = CANONICAL_LANDMARK_LABELS[mapping.semantic];
      const text = labels
        ? this.#localize(labels[0], labels[1])
        : mapping.semantic.replaceAll("_", " ");
      if (!authority.isCurrent()) return false;
      mapping.primary.textContent = text;
      if (!authority.isCurrent()) return false;
    }
    return true;
  }

  updateOverlay(
    resource: ReferenceSkeletonResource,
    robotView: ReferenceSkeletonRobotView,
    authority: SessionInstallAuthority,
  ): boolean {
    const record = this.#currentRecord(resource, authority);
    if (!record) return false;
    const active = record.projectedVisible && record.mappings.length > 0;
    const width = this.#labelRoot.clientWidth;
    if (!authority.isCurrent()) return false;
    const height = this.#labelRoot.clientHeight;
    if (!authority.isCurrent()) return false;
    if (!active || width <= 0 || height <= 0) {
      for (const mapping of record.mappings) {
        mapping.label.style.display = "none";
        if (!authority.isCurrent()) return false;
        mapping.line.style.display = "none";
        if (!authority.isCurrent()) return false;
      }
      return true;
    }

    const referencePoint = new THREE.Vector3();
    const targetPoint = new THREE.Vector3();
    for (const mapping of record.mappings) {
      record.spheres[mapping.index].getWorldPosition(referencePoint);
      if (!authority.isCurrent()) return false;
      if (!robotView.getLinkWorldPosition(mapping.targetLink, targetPoint)) {
        if (!authority.isCurrent()) return false;
        mapping.label.style.display = "none";
        if (!authority.isCurrent()) return false;
        mapping.line.style.display = "none";
        if (!authority.isCurrent()) return false;
        continue;
      }
      if (!authority.isCurrent()) return false;
      const referenceNdc = referencePoint.clone().project(this.#camera);
      if (!authority.isCurrent()) return false;
      const targetNdc = targetPoint.clone().project(this.#camera);
      if (!authority.isCurrent()) return false;
      const inFrustum = referenceNdc.z >= -1 && referenceNdc.z <= 1
        && targetNdc.z >= -1 && targetNdc.z <= 1;
      if (!inFrustum) {
        mapping.label.style.display = "none";
        if (!authority.isCurrent()) return false;
        mapping.line.style.display = "none";
        if (!authority.isCurrent()) return false;
        continue;
      }
      const rx = (referenceNdc.x * 0.5 + 0.5) * width;
      const ry = (-referenceNdc.y * 0.5 + 0.5) * height;
      const tx = (targetNdc.x * 0.5 + 0.5) * width;
      const ty = (-targetNdc.y * 0.5 + 0.5) * height;
      mapping.label.style.display = record.display.labels ? "block" : "none";
      if (!authority.isCurrent()) return false;
      mapping.label.style.left = `${rx}px`;
      if (!authority.isCurrent()) return false;
      mapping.label.style.top = `${ry}px`;
      if (!authority.isCurrent()) return false;
      mapping.line.style.display = record.display.mappingLines ? "inline" : "none";
      if (!authority.isCurrent()) return false;
      mapping.line.setAttribute("x1", String(rx));
      if (!authority.isCurrent()) return false;
      mapping.line.setAttribute("y1", String(ry));
      if (!authority.isCurrent()) return false;
      mapping.line.setAttribute("x2", String(tx));
      if (!authority.isCurrent()) return false;
      mapping.line.setAttribute("y2", String(ty));
      if (!authority.isCurrent()) return false;
    }
    return true;
  }

  diagnostics(
    resource: ReferenceSkeletonResource,
    robotView: ReferenceSkeletonRobotView,
    authority: SessionInstallAuthority,
  ): ReferenceSkeletonDiagnosticsSnapshot | null {
    const record = this.#currentRecord(resource, authority);
    if (!record) return null;
    const alignment = this.#alignmentDiagnostics(record, robotView, authority);
    if (!alignment || !authority.isCurrent()) return null;
    const headingResidualDeg = this.#headingResidualDeg(record, robotView, authority);
    if (!authority.isCurrent()) return null;
    return headingResidualDeg === undefined
      ? null
      : Object.freeze({ alignment, headingResidualDeg });
  }

  #record(resource: ReferenceSkeletonResource): ReferenceSkeletonRecord | null {
    const record = this.#records.get(resource);
    return record && !record.disposed ? record : null;
  }

  #currentRecord(
    resource: ReferenceSkeletonResource,
    authority: SessionInstallAuthority,
  ): ReferenceSkeletonRecord | null {
    return authority.isCurrent() ? this.#record(resource) : null;
  }

  #buildDetached(
    prepared: PreparedReferenceSkeleton,
    authority: SessionInstallAuthority,
  ): ReferenceSkeletonRecord | null {
    const root = new THREE.Group();
    const document = this.#labelRoot.ownerDocument;
    const labelLayer = document.createElement("div");
    const lineLayer = this.#lineRoot.ownerDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "g",
    );
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const extras: ThreeResourceExtras = { geometries, materials };
    const ownGeometry = <Geometry extends THREE.BufferGeometry>(geometry: Geometry): Geometry => {
      geometries.push(geometry);
      return geometry;
    };
    const ownMaterial = <Material extends THREE.Material>(material: Material): Material => {
      materials.push(material);
      return material;
    };
    const spheres: ReferenceSkeletonRecord["spheres"] = [];
    const mappings: ReferenceLandmarkMapping[] = [];
    let mappedMaterial: THREE.MeshStandardMaterial | null = null;
    let contextMaterial: THREE.MeshStandardMaterial | null = null;
    let lines: ReferenceSkeletonRecord["lines"] = null;
    let record: ReferenceSkeletonRecord | null = null;
    let detachedDisposed = false;
    const disposeDetachedOnce = (): void => {
      if (detachedDisposed) return;
      // Take the detached obligation before cleanup: a throwing disposer must
      // still not make the surrounding catch attempt every identity twice.
      detachedDisposed = true;
      this.#disposeDetached(root, labelLayer, lineLayer, extras);
    };

    try {
      root.visible = false;
      labelLayer.className = "calib-landmark-label-session";
      labelLayer.style.display = "none";
      lineLayer.classList.add("calib-mapping-line-session");
      lineLayer.style.display = "none";
      if (!authority.isCurrent()) {
        disposeDetachedOnce();
        return null;
      }

      if (prepared.positions.length > 0) {
        mappedMaterial = ownMaterial(new THREE.MeshStandardMaterial({
          color: prepared.color,
          roughness: 0.34,
          metalness: 0.03,
          emissive: 0x0a4d92,
          emissiveIntensity: 0.62,
          transparent: true,
          opacity: prepared.display.sourceOpacity,
        }));
        contextMaterial = ownMaterial(new THREE.MeshStandardMaterial({
          color: prepared.color,
          roughness: 0.48,
          metalness: 0.02,
          emissive: 0x1a3a66,
          emissiveIntensity: 0.18,
          transparent: true,
          opacity: prepared.display.sourceOpacity * 0.32,
        }));
        const sphereGeometry = ownGeometry(new THREE.SphereGeometry(0.022, 12, 12));
        prepared.positions.forEach((position, index) => {
          const sphere = new THREE.Mesh(sphereGeometry, contextMaterial!);
          sphere.position.set(position[0], position[1], position[2]);
          sphere.visible = !prepared.excluded.has(index);
          root.add(sphere);
          spheres.push(sphere);
        });

        let segmentCount = 0;
        prepared.parents.forEach((parent, index) => {
          if (parent < 0 || prepared.excluded.has(index) || prepared.excluded.has(parent)) return;
          segmentCount += 1;
        });
        const lineGeometry = ownGeometry(new THREE.BufferGeometry());
        const positions = new Float32Array(segmentCount * 2 * 3);
        lineGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const array = (lineGeometry.getAttribute("position") as THREE.BufferAttribute).array;
        let offset = 0;
        prepared.parents.forEach((parent, index) => {
          if (parent < 0 || prepared.excluded.has(index) || prepared.excluded.has(parent)) return;
          const childPosition = prepared.positions[index];
          const parentPosition = prepared.positions[parent];
          array[offset++] = childPosition[0];
          array[offset++] = childPosition[1];
          array[offset++] = childPosition[2];
          array[offset++] = parentPosition[0];
          array[offset++] = parentPosition[1];
          array[offset++] = parentPosition[2];
        });
        (lineGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        lines = new THREE.LineSegments(
          lineGeometry,
          ownMaterial(new THREE.LineBasicMaterial({
            color: prepared.color,
            transparent: true,
            opacity: prepared.display.sourceOpacity * 0.38,
          })),
        );
        root.add(lines);
      }

      for (const preparedMapping of prepared.mappings) {
        const label = document.createElement("span");
        label.className = "calib-landmark-label";
        const primary = document.createElement("strong");
        label.append(primary, document.createTextNode(` · ${preparedMapping.targetLink}`));
        labelLayer.appendChild(label);
        const line = this.#lineRoot.ownerDocument.createElementNS(
          "http://www.w3.org/2000/svg",
          "line",
        );
        lineLayer.appendChild(line);
        mappings.push({ ...preparedMapping, label, primary, line });
      }

      record = {
        root,
        labelLayer,
        lineLayer,
        spheres,
        mappings,
        quaternions: prepared.quaternions,
        excluded: prepared.excluded,
        mappedMaterial,
        contextMaterial,
        lines,
        extras,
        display: { ...prepared.display },
        projectedVisible: false,
        disposed: false,
      };
      if (!authority.isCurrent()) {
        this.#disposeRecord(record);
        return null;
      }
      if (!this.refreshLabelsForRecord(record, authority)) {
        this.#disposeRecord(record);
        return null;
      }
      if (!this.#applyDisplay(record, authority)) {
        this.#disposeRecord(record);
        return null;
      }
      return record;
    } catch (error) {
      const errors: unknown[] = [];
      appendReferenceError(errors, error);
      try {
        if (record) this.#disposeRecord(record);
        else disposeDetachedOnce();
      } catch (cleanupError) {
        appendReferenceError(errors, cleanupError);
      }
      throwReferenceErrors(
        errors,
        "Reference skeleton build failed and rollback was incomplete",
      );
      return null;
    }
  }

  private refreshLabelsForRecord(
    record: ReferenceSkeletonRecord,
    authority: SessionInstallAuthority,
  ): boolean {
    for (const mapping of record.mappings) {
      const labels = CANONICAL_LANDMARK_LABELS[mapping.semantic];
      const text = labels
        ? this.#localize(labels[0], labels[1])
        : mapping.semantic.replaceAll("_", " ");
      if (!authority.isCurrent()) return false;
      mapping.primary.textContent = text;
      if (!authority.isCurrent()) return false;
    }
    return true;
  }

  #applyDisplay(
    record: ReferenceSkeletonRecord,
    authority: SessionInstallAuthority,
  ): boolean {
    const mappedIndices = new Set(record.mappings.map((mapping) => mapping.index));
    record.spheres.forEach((sphere, index) => {
      if (!authority.isCurrent()) return;
      const mapped = mappedIndices.has(index);
      sphere.material = mapped && record.mappedMaterial
        ? record.mappedMaterial
        : record.contextMaterial ?? sphere.material;
      sphere.scale.setScalar(mapped ? 1.12 : 0.62);
      sphere.visible = !record.excluded.has(index) && (mapped || !record.display.mappedOnly);
    });
    if (!authority.isCurrent()) return false;
    if (record.mappedMaterial) record.mappedMaterial.opacity = record.display.sourceOpacity;
    if (!authority.isCurrent()) return false;
    if (record.contextMaterial) {
      record.contextMaterial.opacity = record.display.sourceOpacity * 0.32;
    }
    if (!authority.isCurrent()) return false;
    if (record.lines) record.lines.material.opacity = record.display.sourceOpacity * 0.38;
    if (!authority.isCurrent()) return false;
    record.labelLayer.style.display = record.projectedVisible && record.display.labels
      ? "contents"
      : "none";
    if (!authority.isCurrent()) return false;
    record.lineLayer.style.display = record.projectedVisible && record.display.mappingLines
      ? "inline"
      : "none";
    return authority.isCurrent();
  }

  #alignmentDiagnostics(
    record: ReferenceSkeletonRecord,
    robotView: ReferenceSkeletonRobotView,
    authority: SessionInstallAuthority,
  ): readonly ReferenceAlignmentDiagnostic[] | null {
    const referencePosition = new THREE.Vector3();
    const targetPosition = new THREE.Vector3();
    const targetQuaternion = new THREE.Quaternion();
    const worldQuaternion = new THREE.Quaternion();
    this.group.parent?.getWorldQuaternion(worldQuaternion);
    if (!authority.isCurrent()) return null;
    const diagnostics: ReferenceAlignmentDiagnostic[] = [];
    for (const mapping of record.mappings) {
      record.spheres[mapping.index].getWorldPosition(referencePosition);
      if (!authority.isCurrent()) return null;
      if (!robotView.getLinkWorldPosition(mapping.targetLink, targetPosition)) {
        if (!authority.isCurrent()) return null;
        continue;
      }
      if (!authority.isCurrent()) return null;
      let rotationResidualDeg: number | null = null;
      const rawQuaternion = record.quaternions[mapping.index];
      if (rawQuaternion) {
        const hasQuaternion = robotView.getLinkWorldQuaternion(
          mapping.targetLink,
          targetQuaternion,
        );
        if (!authority.isCurrent()) return null;
        if (hasQuaternion) {
          const referenceQuaternion = worldQuaternion.clone().multiply(
            new THREE.Quaternion(...rawQuaternion),
          );
          const dot = Math.min(1, Math.abs(referenceQuaternion.dot(targetQuaternion)));
          rotationResidualDeg = 2 * Math.acos(dot) * 180 / Math.PI;
        }
      }
      diagnostics.push(Object.freeze({
        semantic: mapping.semantic,
        targetLink: mapping.targetLink,
        positionResidualM: referencePosition.distanceTo(targetPosition),
        verticalResidualM: Math.abs(referencePosition.z - targetPosition.z),
        rotationResidualDeg,
      }));
    }
    return Object.freeze(diagnostics);
  }

  #headingResidualDeg(
    record: ReferenceSkeletonRecord,
    robotView: ReferenceSkeletonRobotView,
    authority: SessionInstallAuthority,
  ): number | null | undefined {
    const findMapping = (semantic: string): ReferenceLandmarkMapping | undefined => (
      record.mappings.find((mapping) => (
        normalizedSemanticName(mapping.semantic) === normalizedSemanticName(semantic)
      ))
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
      record.spheres[left.index].getWorldPosition(refLeft);
      if (!authority.isCurrent()) return undefined;
      record.spheres[right.index].getWorldPosition(refRight);
      if (!authority.isCurrent()) return undefined;
      if (!robotView.getLinkWorldPosition(left.targetLink, targetLeft)) {
        if (!authority.isCurrent()) return undefined;
        continue;
      }
      if (!authority.isCurrent()) return undefined;
      if (!robotView.getLinkWorldPosition(right.targetLink, targetRight)) {
        if (!authority.isCurrent()) return undefined;
        continue;
      }
      if (!authority.isCurrent()) return undefined;
      const referenceAxis = refRight.clone().sub(refLeft).setZ(0);
      const targetAxis = targetRight.clone().sub(targetLeft).setZ(0);
      if (referenceAxis.lengthSq() < 1e-8 || targetAxis.lengthSq() < 1e-8) continue;
      return referenceAxis.angleTo(targetAxis) * 180 / Math.PI;
    }
    return null;
  }

  #disposeRecord(record: ReferenceSkeletonRecord): void {
    if (record.disposed) return;
    record.disposed = true;
    const errors: unknown[] = [];
    const capture = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        appendReferenceError(errors, error);
      }
    };
    capture(() => { record.root.visible = false; });
    capture(() => { record.labelLayer.style.display = "none"; });
    capture(() => { record.lineLayer.style.display = "none"; });
    capture(() => { this.group.remove(record.root); });
    capture(() => { record.labelLayer.remove(); });
    capture(() => { record.lineLayer.remove(); });
    capture(() => this.#resourceDisposer.disposeObject3DResources(
      record.root,
      record.extras,
    ));
    capture(() => { record.root.clear(); });
    throwReferenceErrors(errors, "Reference skeleton cleanup failed");
  }

  #disposeDetached(
    root: THREE.Group,
    labelLayer: HTMLElement,
    lineLayer: SVGGElement,
    extras: ThreeResourceExtras,
  ): void {
    const errors: unknown[] = [];
    const capture = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        appendReferenceError(errors, error);
      }
    };
    capture(() => { root.visible = false; });
    capture(() => { labelLayer.style.display = "none"; });
    capture(() => { lineLayer.style.display = "none"; });
    capture(() => { root.removeFromParent(); });
    capture(() => { labelLayer.remove(); });
    capture(() => { lineLayer.remove(); });
    capture(() => this.#resourceDisposer.disposeObject3DResources(root, extras));
    capture(() => { root.clear(); });
    throwReferenceErrors(errors, "Detached reference skeleton cleanup failed");
  }
}
