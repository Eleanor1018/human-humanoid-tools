import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/addons/loaders/GLTFLoader.js";

import { ThreeResourceDisposer } from "@/platform/graphics/common/three-resource-disposer";
import type {
  Matrix4Data,
  RobotPayload,
  RobotTrajectoryPayload,
} from "../types";
import type { AsyncStageViewLoadResult } from "./async-stage-view-load-result";
import {
  effectivePlaybackDuration,
  resolvePlaybackFrame,
} from "./playback-timing";

export type RobotGltf = Pick<GLTF, "scene" | "scenes">;
export type RobotGltfParser = (buffer: ArrayBuffer) => Promise<RobotGltf>;
export type RobotViewWarningReporter = (
  message: string,
  ...details: readonly unknown[]
) => void;

export interface RobotViewOptions {
  /** Injectable because GLTF parsing is asynchronous and has no cancel handle. */
  readonly parseGltf?: RobotGltfParser;
  readonly reportWarning?: RobotViewWarningReporter;
  readonly resourceDisposer?: ThreeResourceDisposer;
}

export interface RobotLinkMeshEntry {
  readonly mesh: THREE.Mesh;
  readonly baked: THREE.Matrix4;
}

interface RobotMetadata {
  readonly links: string[];
  readonly meshToLink: Record<string, string>;
  readonly zero: Record<string, Matrix4Data>;
  readonly zeroInv: Record<string, THREE.Matrix4>;
  readonly groundOffset: number;
}

/** Every GPU allocation produced by one load generation has one terminal owner. */
interface RobotResourceRecord {
  readonly liveRoot: THREE.Group;
  readonly residualRoots: THREE.Object3D[];
  readonly detachedGeometries: THREE.BufferGeometry[];
  readonly detachedMaterials: THREE.Material[];
  disposed: boolean;
}

interface RobotCandidate {
  readonly metadata: RobotMetadata;
  readonly linkMeshes: Record<string, RobotLinkMeshEntry[]>;
  readonly resources: RobotResourceRecord;
}

const robotLinkDelta = new THREE.Matrix4();
const robotMeshMatrix = new THREE.Matrix4();
const robotLinkMatrix = new THREE.Matrix4();
const robotWorldLinkMatrix = new THREE.Matrix4();
const robotRootQuaternionB = new THREE.Quaternion();
const robotMatrixB = new THREE.Matrix4();
const robotPositionA = new THREE.Vector3();
const robotPositionB = new THREE.Vector3();
const robotQuaternionA = new THREE.Quaternion();
const robotQuaternionB = new THREE.Quaternion();
const robotScaleA = new THREE.Vector3();
const robotScaleB = new THREE.Vector3();

const defaultWarningReporter: RobotViewWarningReporter = (
  message,
  ...details
) => {
  console.warn(message, ...details);
};

function defaultRobotGltfParser(buffer: ArrayBuffer): Promise<RobotGltf> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    let settled = false;
    const resolveOnce = (gltf: GLTF): void => {
      if (settled) return;
      settled = true;
      resolve(gltf);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      loader.parse(buffer, "", resolveOnce, rejectOnce);
    } catch (error) {
      rejectOnce(error);
    }
  });
}

function decodeBase64Glb(encoded: string): ArrayBuffer {
  const bytes = Uint8Array.from(
    atob(encoded),
    (character) => character.charCodeAt(0),
  );
  return bytes.buffer as ArrayBuffer;
}

function matrix4Into(flat: Matrix4Data, out: THREE.Matrix4): THREE.Matrix4 {
  // The backend serializes row-major matrices; Three.js stores column-major.
  return out.set(
    flat[0], flat[1], flat[2], flat[3],
    flat[4], flat[5], flat[6], flat[7],
    flat[8], flat[9], flat[10], flat[11],
    flat[12], flat[13], flat[14], flat[15],
  );
}

function matrix4(flat: Matrix4Data): THREE.Matrix4 {
  return matrix4Into(flat, new THREE.Matrix4());
}

function normalizePickKey(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function meshBasename(name: unknown): string {
  const base = String(name || "").split(/[/\\]/).pop();
  return (base ?? "").replace(/\.[^.]+$/, "");
}

function linkForNode(
  node: THREE.Object3D,
  links: readonly string[],
  meshToLink: Readonly<Record<string, string>>,
): string | null {
  let current: THREE.Object3D | null = node;
  while (current) {
    const tagged = current.userData?.hhtoolsLink;
    if (tagged) return String(tagged);
    const rawName = current.name || "";
    if (meshToLink[rawName]) return meshToLink[rawName];
    const baseName = meshBasename(rawName);
    if (meshToLink[baseName]) return meshToLink[baseName];
    const normalizedName = normalizePickKey(rawName);
    for (const link of links) {
      if (normalizePickKey(link) === normalizedName && normalizedName) return link;
    }
    const normalizedBase = normalizePickKey(baseName);
    if (normalizedBase) {
      for (const link of links) {
        const normalizedLink = normalizePickKey(link);
        const withoutSuffix = normalizedLink.endsWith("link")
          ? normalizedLink.slice(0, -4)
          : normalizedLink;
        if (withoutSuffix === normalizedBase || normalizedLink === normalizedBase) {
          return link;
        }
      }
    }
    current = current.parent;
  }
  return null;
}

function newResourceRecord(
  residualRoots: readonly THREE.Object3D[] = [],
): RobotResourceRecord {
  return {
    liveRoot: new THREE.Group(),
    residualRoots: [...new Set(residualRoots)],
    detachedGeometries: [],
    detachedMaterials: [],
    disposed: false,
  };
}

function createRobotMaterial(
  resources: RobotResourceRecord,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xc8ccd4,
    emissive: 0x6b7280,
    emissiveIntensity: 0.55,
    roughness: 0.6,
    metalness: 0.15,
    side: THREE.DoubleSide,
    vertexColors: false,
  });
  // Keep an explicit alias until terminal disposal. It also covers an error
  // thrown after allocation but before the material reaches the live graph.
  resources.detachedMaterials.push(material);
  return material;
}

function applyRobotMaterial(
  mesh: THREE.Mesh,
  resources: RobotResourceRecord,
): void {
  const original = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];
  resources.detachedMaterials.push(...original);
  mesh.material = Array.isArray(mesh.material)
    ? mesh.material.map(() => createRobotMaterial(resources))
    : createRobotMaterial(resources);
}

/**
 * Owns one robot model and its optional trajectory.
 *
 * Construction is inert: the compatibility composition root decides which
 * Scene owns `group`. A load owns all parse/build resources in locals and
 * publishes them only after its generation is still current, preventing late
 * GLTF callbacks from resurrecting a cleared or replaced robot.
 */
export class RobotView {
  readonly group = new THREE.Group();
  linkMeshes: Record<string, RobotLinkMeshEntry[]> = {};
  meshToLink: Record<string, string> = {};
  zeroInv: Record<string, THREE.Matrix4> = {};
  zero: Record<string, Matrix4Data> = {};
  currentLinkTransforms: Record<string, Matrix4Data> = {};
  links: string[] = [];
  trajectory: RobotTrajectoryPayload | null = null;
  frameIndices: number[] | null | undefined = null;
  groundOffset = 0;
  clipDuration = 1;
  readonly heavy = true;

  readonly #parseGltf: RobotGltfParser;
  readonly #reportWarning: RobotViewWarningReporter;
  readonly #resourceDisposer: ThreeResourceDisposer;
  #clearing = false;
  #loadGeneration = 0;
  #resources: RobotResourceRecord | null = null;

  constructor(options: RobotViewOptions = {}) {
    this.group.visible = false;
    this.#parseGltf = options.parseGltf ?? defaultRobotGltfParser;
    this.#reportWarning = options.reportWarning ?? defaultWarningReporter;
    this.#resourceDisposer = options.resourceDisposer ?? new ThreeResourceDisposer();
  }

  clear(): void {
    // GLTFLoader cannot be cancelled. Invalidate before any listener can
    // re-enter so every subsequent load reserves a distinct generation.
    this.#loadGeneration += 1;
    if (this.#clearing) return;
    this.#clearing = true;
    const resources = this.#resources ?? newResourceRecord();
    this.#resources = null;
    try {
      this.#disposeResources(resources, this.group.children);
    } finally {
      try {
        this.group.clear();
      } finally {
        this.#resetAliasesAndTransform();
        this.#clearing = false;
      }
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * Snapshot the generation immediately after calling load(). Callers use the
   * value only to decide whether a rejected attempt still owns workflow state.
   */
  get loadGeneration(): number {
    return this.#loadGeneration;
  }

  /**
   * Claim the current committed content for a new outer intent while making
   * every in-flight parser stale. Unlike clear(), this does not dispose the
   * stable content; the claimant may reuse it when its robot identity matches.
   */
  claimLoadGeneration(): number {
    this.#loadGeneration += 1;
    return this.#loadGeneration;
  }

  /** Prevent an older rejection from clearing state owned by a newer load. */
  isLoadGenerationCurrent(generation: number): boolean {
    return this.#isCurrent(generation);
  }

  /** No trajectory yet: place the robot at its zero/T-pose on the ground. */
  applyStatic(): void {
    this.group.position.set(0, 0, this.groundOffset);
    this.group.quaternion.identity();
    this.group.scale.set(1, 1, 1);
    for (const link of this.links) {
      const entries = this.linkMeshes[link];
      if (!entries) continue;
      for (const { mesh, baked } of entries) mesh.matrix.copy(baked);
    }
    this.currentLinkTransforms = this.zero;
    this.group.updateMatrixWorld(true);
  }

  async load(robot: RobotPayload): Promise<AsyncStageViewLoadResult> {
    // Reserve before clear(): a dispose listener may synchronously start a
    // newer load, and this outer attempt must never adopt that generation.
    const generation = this.#loadGeneration + 1;
    try {
      this.clear();
    } catch (error) {
      // A disposal observer may both start a newer load and throw. The outer
      // attempt is superseded in that case; surfacing its cleanup error would
      // make callers invalidate state that already belongs to the new load.
      if (!this.#isCurrent(generation)) return "stale";
      throw error;
    }
    // A no-GLB fallback is otherwise fully synchronous and could commit from a
    // dispose listener before the outer clear releases its aliases.
    await Promise.resolve();
    if (!this.#isCurrent(generation)) return "stale";

    let metadata: RobotMetadata;
    try {
      metadata = this.#buildMetadata(robot);
    } catch (error) {
      if (!this.#isCurrent(generation)) return "stale";
      throw error;
    }

    if (!robot.glb_base64) {
      return this.#buildAndCommitFallback(metadata, generation);
    }

    let gltf: RobotGltf;
    try {
      const buffer = decodeBase64Glb(robot.glb_base64);
      gltf = await this.#parseGltf(buffer);
    } catch (error) {
      if (!this.#isCurrent(generation)) return "stale";
      this.#reportWarningSafely("robot GLTF parse failed", error);
      return this.#buildAndCommitFallback(metadata, generation);
    }

    const resources = newResourceRecord([gltf.scene, ...(gltf.scenes ?? [])]);
    if (!this.#isCurrent(generation)) {
      this.#disposeResourcesSafely(resources, "stale robot GLTF cleanup failed");
      return "stale";
    }

    let candidate: RobotCandidate;
    try {
      candidate = this.#buildGltfCandidate(gltf, metadata, resources);
      if (Object.keys(candidate.linkMeshes).length === 0) {
        this.#buildFallbackMeshes(candidate);
      }
    } catch (error) {
      this.#disposeResourcesSafely(resources, "failed robot GLTF cleanup failed");
      if (!this.#isCurrent(generation)) return "stale";
      this.#reportWarningSafely("robot GLTF processing failed", error);
      return this.#buildAndCommitFallback(metadata, generation);
    }

    if (!this.#isCurrent(generation)) {
      this.#disposeResourcesSafely(resources, "stale robot GLTF cleanup failed");
      return "stale";
    }

    try {
      return this.#commitCandidate(candidate, generation);
    } catch (error) {
      if (!this.#isCurrent(generation)) return "stale";
      this.#reportWarningSafely("robot GLTF commit failed", error);
      return this.#buildAndCommitFallback(metadata, generation);
    }
  }

  _linkForNode(node: THREE.Object3D): string | null {
    return linkForNode(node, this.links, this.meshToLink);
  }

  setTrajectory(trajectory: RobotTrajectoryPayload): void {
    this.trajectory = trajectory;
    this.frameIndices = trajectory.frame_indices;
    this.clipDuration = effectivePlaybackDuration(trajectory);
    this.setFrame(0);
  }

  get numFrames(): number {
    return this.trajectory ? this.trajectory.frames.length : 0;
  }

  setFrame(frame: number): void {
    this.setFrameFrac(frame);
  }

  setFrameFrac(frame: number): void {
    if (!this.trajectory) return;
    const maximumFrame = this.trajectory.frames.length - 1;
    const { ia, ib, t } = resolvePlaybackFrame(
      this.frameIndices,
      frame,
      maximumFrame,
    );
    const first = this.trajectory.frames[ia];
    if (!first) return;
    const second = t > 1e-5 && ia !== ib
      ? this.trajectory.frames[ib]
      : null;
    const root = first.root;
    const firstLift = first.mesh_z_lift || 0;
    const secondLift = second?.mesh_z_lift ?? firstLift;
    const meshLift = firstLift + (secondLift - firstLift) * t;
    if (root) {
      if (second?.root && t > 1e-5 && ia !== ib) {
        const nextRoot = second.root;
        this.group.position.set(
          root[0] + (nextRoot[0] - root[0]) * t,
          root[1] + (nextRoot[1] - root[1]) * t,
          root[2] + (nextRoot[2] - root[2]) * t + meshLift,
        );
        this.group.quaternion.set(root[3], root[4], root[5], root[6]);
        robotRootQuaternionB.set(
          nextRoot[3],
          nextRoot[4],
          nextRoot[5],
          nextRoot[6],
        );
        this.group.quaternion.slerp(robotRootQuaternionB, t);
      } else {
        this.group.position.set(root[0], root[1], root[2] + meshLift);
        this.group.quaternion.set(root[3], root[4], root[5], root[6]);
      }
    }
    this.#applyLinkTransforms(first.links, second?.links ?? null, t);
  }

  /** Pose link meshes from FK (calibration preview) or a trajectory frame. */
  #applyLinkTransforms(
    linkTransforms: Record<string, Matrix4Data>,
    nextTransforms: Record<string, Matrix4Data> | null = null,
    blend = 0,
  ): void {
    this.currentLinkTransforms = linkTransforms;
    const interpolate = nextTransforms != null && blend > 1e-5;
    for (const link of this.links) {
      const entries = this.linkMeshes[link];
      if (!entries || !linkTransforms[link]) continue;
      matrix4Into(linkTransforms[link], robotLinkMatrix);
      if (interpolate && nextTransforms[link]) {
        matrix4Into(nextTransforms[link], robotMatrixB);
        robotLinkMatrix.decompose(
          robotPositionA,
          robotQuaternionA,
          robotScaleA,
        );
        robotMatrixB.decompose(
          robotPositionB,
          robotQuaternionB,
          robotScaleB,
        );
        robotPositionA.lerp(robotPositionB, blend);
        robotQuaternionA.slerp(robotQuaternionB, blend);
        robotLinkMatrix.compose(robotPositionA, robotQuaternionA, robotScaleA);
      }
      robotLinkDelta.copy(robotLinkMatrix).multiply(this.zeroInv[link]);
      for (const { mesh, baked } of entries) {
        robotMeshMatrix.copy(robotLinkDelta).multiply(baked);
        mesh.matrix.copy(robotMeshMatrix);
      }
    }
    this.group.updateMatrixWorld(true);
  }

  /** Static calibration pose on the ground (no floating-base trajectory yet). */
  applyCalibPose(
    linkTransforms: Record<string, Matrix4Data>,
    groundZ?: number | null,
  ): void {
    const z = groundZ != null && Number.isFinite(groundZ)
      ? groundZ
      : this.groundOffset;
    this.group.position.set(0, 0, z);
    this.group.quaternion.identity();
    this.group.scale.set(1, 1, 1);
    this.#applyLinkTransforms(linkTransforms);
  }

  getLinkWorldPosition(link: string, output: THREE.Vector3): boolean {
    const transform = this.currentLinkTransforms[link] ?? this.zero[link];
    if (!transform) return false;
    matrix4Into(transform, robotLinkMatrix);
    this.group.updateMatrixWorld(true);
    robotWorldLinkMatrix.copy(this.group.matrixWorld).multiply(robotLinkMatrix);
    output.setFromMatrixPosition(robotWorldLinkMatrix);
    return true;
  }

  getLinkWorldQuaternion(link: string, output: THREE.Quaternion): boolean {
    const transform = this.currentLinkTransforms[link] ?? this.zero[link];
    if (!transform) return false;
    matrix4Into(transform, robotLinkMatrix);
    this.group.updateMatrixWorld(true);
    robotWorldLinkMatrix.copy(this.group.matrixWorld).multiply(robotLinkMatrix);
    robotWorldLinkMatrix.decompose(robotPositionA, output, robotScaleA);
    return true;
  }

  setOpacity(value: number): void {
    const opacity = Math.min(1, Math.max(0.1, value));
    this.group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        material.opacity = opacity;
        material.transparent = opacity < 0.999;
        material.depthWrite = opacity >= 0.55;
        material.needsUpdate = true;
      }
    });
  }

  /** Calibration pick/hover tint (hover = blue, selected = accent). */
  setCalibHighlights({
    hover = null,
    selected = null,
  }: { hover?: string | null; selected?: string | null } = {}): void {
    const base = {
      color: 0xc8ccd4,
      emissive: 0x6b7280,
      emissiveIntensity: 0.55,
    };
    const hovered = {
      color: 0xd6e4ff,
      emissive: 0x3b82f6,
      emissiveIntensity: 0.92,
    };
    const active = {
      color: 0xbfdbfe,
      emissive: 0x1d4ed8,
      emissiveIntensity: 1.15,
    };
    for (const [link, entries] of Object.entries(this.linkMeshes)) {
      let palette = base;
      if (selected && link === selected) palette = active;
      else if (hover && link === hover) palette = hovered;
      for (const { mesh } of entries) {
        const materials = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        for (const material of materials) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue;
          material.color.setHex(palette.color);
          material.emissive.setHex(palette.emissive);
          material.emissiveIntensity = palette.emissiveIntensity;
        }
      }
    }
  }

  #buildMetadata(robot: RobotPayload): RobotMetadata {
    const links = [...robot.links];
    const zero = { ...robot.link_transforms_zero };
    const zeroInv: Record<string, THREE.Matrix4> = {};
    for (const link of links) zeroInv[link] = matrix4(zero[link]).invert();
    return {
      links,
      meshToLink: { ...(robot.mesh_to_link ?? {}) },
      zero,
      zeroInv,
      groundOffset: robot.ground_offset_z || 0,
    };
  }

  #buildGltfCandidate(
    gltf: RobotGltf,
    metadata: RobotMetadata,
    resources: RobotResourceRecord,
  ): RobotCandidate {
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });

    const linkMeshes: Record<string, RobotLinkMeshEntry[]> = {};
    for (const mesh of meshes) {
      const link = linkForNode(mesh, metadata.links, metadata.meshToLink);
      if (!link) continue;
      mesh.userData.hhtoolsLink = link;
      const baked = mesh.matrixWorld.clone();
      mesh.matrixAutoUpdate = false;
      if (mesh.geometry && !mesh.geometry.getAttribute("normal")) {
        mesh.geometry.computeVertexNormals();
      }
      applyRobotMaterial(mesh, resources);
      resources.liveRoot.add(mesh);
      mesh.matrix.copy(baked);
      mesh.updateMatrixWorld(true);
      (linkMeshes[link] ||= []).push({ mesh, baked });
    }
    resources.liveRoot.updateMatrixWorld(true);
    return { metadata, linkMeshes, resources };
  }

  #buildFallbackMeshes(candidate: RobotCandidate): void {
    const geometry = new THREE.SphereGeometry(0.02, 8, 8);
    const material = new THREE.MeshStandardMaterial({ color: 0xb8bdc6 });
    // Explicit extras cover an empty link list and are identity-deduplicated
    // against the meshes that normally make these resources reachable.
    candidate.resources.detachedGeometries.push(geometry);
    candidate.resources.detachedMaterials.push(material);
    for (const link of candidate.metadata.links) {
      const baked = matrix4(candidate.metadata.zero[link]);
      const sphere = new THREE.Mesh(geometry, material);
      sphere.userData.hhtoolsLink = link;
      sphere.matrixAutoUpdate = false;
      sphere.matrix.copy(baked);
      candidate.resources.liveRoot.add(sphere);
      (candidate.linkMeshes[link] ||= []).push({ mesh: sphere, baked });
    }
  }

  #buildAndCommitFallback(
    metadata: RobotMetadata,
    generation: number,
  ): AsyncStageViewLoadResult {
    const resources = newResourceRecord();
    const candidate: RobotCandidate = { metadata, linkMeshes: {}, resources };
    try {
      this.#buildFallbackMeshes(candidate);
      if (!this.#isCurrent(generation)) {
        this.#disposeResourcesSafely(resources, "stale robot fallback cleanup failed");
        return "stale";
      }
      return this.#commitCandidate(candidate, generation);
    } catch (error) {
      this.#disposeResourcesSafely(resources, "failed robot fallback cleanup failed");
      if (!this.#isCurrent(generation)) return "stale";
      throw error;
    }
  }

  #commitCandidate(
    candidate: RobotCandidate,
    generation: number,
  ): AsyncStageViewLoadResult {
    const { metadata, linkMeshes, resources } = candidate;
    if (!this.#isCurrent(generation)) {
      this.#disposeResourcesSafely(resources, "stale robot candidate cleanup failed");
      return "stale";
    }

    // Publish the complete resource inventory before graph attachment. An
    // `added`/`removed`/dispose listener may synchronously call clear(), which
    // must be able to terminalize every candidate allocation exactly once.
    this.#resources = resources;
    try {
      this.group.position.set(0, 0, metadata.groundOffset);
      this.group.quaternion.identity();
      this.group.scale.set(1, 1, 1);
      this.group.add(resources.liveRoot);
      this.group.updateMatrixWorld(true);
      if (!this.#isCurrent(generation)) {
        // A claim-only successor can invalidate A after attachment without
        // calling clear(). Retire only A's exact resource record; a successor
        // installed reentrantly has already replaced #resources and survives.
        if (this.#resources === resources) {
          this.#resources = null;
          this.#disposeResourcesSafely(
            resources,
            "stale robot commit cleanup failed",
          );
          if (this.#resources === null) this.#resetAliasesAndTransform();
        }
        return "stale";
      }
    } catch (error) {
      const stillCurrent = this.#isCurrent(generation);
      if (this.#resources === resources) {
        this.#resources = null;
        this.#disposeResourcesSafely(resources, "failed robot commit cleanup failed");
        this.group.clear();
        this.#resetAliasesAndTransform();
      }
      if (!stillCurrent || !this.#isCurrent(generation)) return "stale";
      throw error;
    }

    // No fallible work remains after the aliases become observable.
    this.links = metadata.links;
    this.meshToLink = metadata.meshToLink;
    this.zero = metadata.zero;
    this.zeroInv = metadata.zeroInv;
    this.currentLinkTransforms = metadata.zero;
    this.groundOffset = metadata.groundOffset;
    this.linkMeshes = linkMeshes;
    return "committed";
  }

  #disposeResources(
    resources: RobotResourceRecord,
    additionalRoots: readonly THREE.Object3D[] = [],
  ): void {
    if (resources.disposed) return;
    // Mark first: moving roots into the terminal owner dispatches graph events
    // that are allowed to re-enter clear/load without acquiring this record.
    resources.disposed = true;
    const owner = new THREE.Group();
    const roots = new Set<THREE.Object3D>([
      resources.liveRoot,
      ...resources.residualRoots,
      ...additionalRoots,
    ]);
    const setupErrors: unknown[] = [];
    for (const root of roots) {
      try {
        owner.add(root);
      } catch (error) {
        setupErrors.push(error);
        // Object3D.add dispatches after insertion. If a custom implementation
        // threw before insertion, force ownership so the one disposal pass can
        // still see the resource graph.
        if (root.parent !== owner) {
          if (root.parent) {
            const index = root.parent.children.indexOf(root);
            if (index >= 0) root.parent.children.splice(index, 1);
          }
          root.parent = owner;
          owner.children.push(root);
        }
      }
    }

    let disposalError: unknown;
    try {
      this.#resourceDisposer.disposeObject3DChildren(owner, {
        geometries: resources.detachedGeometries,
        materials: resources.detachedMaterials,
      });
    } catch (error) {
      disposalError = error;
    } finally {
      // A throwing `removed` observer can interrupt Object3D.clear(). Sever the
      // temporary terminal graph regardless; aliases are released by caller.
      for (const root of owner.children) {
        if (root.parent === owner) root.parent = null;
      }
      owner.children.length = 0;
    }

    const errors = disposalError === undefined
      ? setupErrors
      : [...setupErrors, disposalError];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to terminate robot resources");
    }
  }

  #disposeResourcesSafely(
    resources: RobotResourceRecord,
    context: string,
  ): void {
    try {
      this.#disposeResources(resources);
    } catch (error) {
      this.#reportWarningSafely(context, error);
    }
  }

  #resetAliasesAndTransform(): void {
    this.linkMeshes = {};
    this.meshToLink = {};
    this.zeroInv = {};
    this.zero = {};
    this.currentLinkTransforms = {};
    this.links = [];
    this.trajectory = null;
    this.frameIndices = null;
    this.groundOffset = 0;
    this.clipDuration = 1;
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.scale.set(1, 1, 1);
    this.group.updateMatrixWorld(true);
  }

  #isCurrent(generation: number): boolean {
    return this.#loadGeneration === generation;
  }

  #reportWarningSafely(
    message: string,
    ...details: readonly unknown[]
  ): void {
    try {
      this.#reportWarning(message, ...details);
    } catch {
      // Reporting is observational and cannot alter generation ownership.
    }
  }
}
