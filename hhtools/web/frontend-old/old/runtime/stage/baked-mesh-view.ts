import * as THREE from "three";

import type { BodyMeshPayload } from "@/domain/motion/common/motion";
import { ThreeResourceDisposer } from "@/platform/graphics/common/three-resource-disposer";
import type { AsyncStageViewLoadResult } from "./async-stage-view-load-result";

export type BakedMeshDecoder = (encodedVertices: string) => Promise<Float32Array>;
export type BakedMeshWarningReporter = (
  message: string,
  ...details: readonly unknown[]
) => void;
export type BakedMeshStageDisposition = "staged" | "superseded";

export interface BakedMeshViewOptions {
  /** Injectable because browser decompression is asynchronous and non-cancellable. */
  readonly decodeVertices?: BakedMeshDecoder;
  readonly reportWarning?: BakedMeshWarningReporter;
  readonly resourceDisposer?: ThreeResourceDisposer;
}

declare const bakedMeshRetirementBrand: unique symbol;

/** Opaque exact handle for one previously published baked-body generation. */
export interface BakedMeshRetirement {
  readonly [bakedMeshRetirementBrand]: true;
}

/** Detached body candidate whose resources have exactly one terminal owner. */
export interface PreparedBakedMesh {
  /** Attach the hidden candidate while preserving currently published content. */
  stage(isCurrent?: () => boolean): BakedMeshStageDisposition;
  /** Callback-free local preflight for an aggregate multi-View publication. */
  canPublish(): boolean;
  /** Switch aliases/root visibility without invoking Three.js or caller code. */
  publish(): BakedMeshRetirement | null;
  /** Compatibility one-shot replacement built from stage/publish/retire. */
  commit(isCurrent?: () => boolean): AsyncStageViewLoadResult;
  /** Release an uncommitted candidate; repeated terminal calls are neutral. */
  abandon(): void;
  /** Exact installed identity used by an aggregate source-motion transaction. */
  isPublishedCurrent(): boolean;
}

export type BakedMeshPreparationResult =
  | { readonly status: "prepared"; readonly preparation: PreparedBakedMesh }
  | { readonly status: "stale" };

interface BakedMeshGeneration {
  readonly retirement: BakedMeshRetirement;
  readonly root: THREE.Group;
  /** Complete graph identity owned before any observable attachment callback. */
  readonly ownedNodes: Set<THREE.Object3D>;
  readonly mesh:
    | THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
    | null;
  readonly vertices: Float32Array | null;
  readonly numVerts: number;
  readonly geometry: THREE.BufferGeometry | null;
  readonly material: THREE.MeshStandardMaterial | null;
  retired: boolean;
}

async function decodeGzipVertices(encodedVertices: string): Promise<Float32Array> {
  const compressed = Uint8Array.from(
    atob(encodedVertices),
    (character) => character.charCodeAt(0),
  );
  const decompressor = new DecompressionStream("gzip");
  const buffer = await new Response(
    new Blob([compressed]).stream().pipeThrough(decompressor),
  ).arrayBuffer();
  return new Float32Array(buffer);
}

const defaultWarningReporter: BakedMeshWarningReporter = (
  message,
  ...details
) => {
  console.warn(message, ...details);
};

/**
 * Owns one optional SMPL-style baked body mesh and its decoded frame buffer.
 *
 * Construction is inert. A candidate is decoded and built under a detached
 * child root, staged invisibly beside the stable generation, then published by
 * plain alias/visibility writes. Exact retirement never clears the stable Group,
 * so disposal re-entry cannot remove a successor installed under that Group.
 */
export class BakedMeshView {
  readonly group = new THREE.Group();
  readonly heavy = true;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  verts: Float32Array | null = null;
  numVerts = 0;
  ready = false;
  clipDuration: number | null = null;

  readonly #decodeVertices: BakedMeshDecoder;
  readonly #reportWarning: BakedMeshWarningReporter;
  readonly #resourceDisposer: ThreeResourceDisposer;
  readonly #generations = new WeakMap<BakedMeshRetirement, BakedMeshGeneration>();
  readonly #terminalNodes = new WeakSet<THREE.Object3D>();
  #content: BakedMeshGeneration | null = null;
  #loadGeneration = 0;
  #stageGeneration = 0;

  constructor(options: BakedMeshViewOptions = {}) {
    this.group.visible = false;
    this.#decodeVertices = options.decodeVertices ?? decodeGzipVertices;
    this.#reportWarning = options.reportWarning ?? defaultWarningReporter;
    this.#resourceDisposer = options.resourceDisposer ?? new ThreeResourceDisposer();
  }

  /**
   * Revoke an escaped compatibility decoder without clearing stable content.
   * Detached aggregate preparations deliberately use their external authority
   * instead of this local latest-generation counter.
   */
  claimLoadGeneration(): number {
    this.#loadGeneration += 1;
    return this.#loadGeneration;
  }

  clear(): void {
    this.claimLoadGeneration();
    this.#stageGeneration += 1;
    const retired = this.#content?.retirement ?? null;
    if (this.#content) this.#content.root.visible = false;
    this.#content = null;
    this.#releaseAliases();
    this.retire(retired);
  }

  /**
   * Decode a candidate owned solely by the supplied aggregate authority.
   *
   * Unlike `prepare`, this does not claim or compare `#loadGeneration`, so a
   * source-motion transaction can prepare all Views under one domain lease.
   */
  async prepareDetached(
    bodyMesh: BodyMeshPayload | null | undefined,
    isCurrent: () => boolean = () => true,
  ): Promise<BakedMeshPreparationResult> {
    return this.#prepareWithAuthority(bodyMesh, isCurrent);
  }

  /** Preserve the existing latest-wins compatibility preparation contract. */
  async prepare(
    bodyMesh: BodyMeshPayload | null | undefined,
  ): Promise<BakedMeshPreparationResult> {
    const generation = this.claimLoadGeneration();
    return this.#prepareWithAuthority(
      bodyMesh,
      () => this.#loadGeneration === generation,
    );
  }

  async load(
    bodyMesh: BodyMeshPayload | null | undefined,
  ): Promise<AsyncStageViewLoadResult> {
    const result = await this.prepare(bodyMesh);
    return result.status === "stale"
      ? "stale"
      : result.preparation.commit();
  }

  /** Retire only the generation named by this exact opaque handle. */
  retire(retirement: BakedMeshRetirement | null): void {
    if (!retirement) return;
    const generation = this.#generations.get(retirement);
    if (!generation) return;
    if (this.#content === generation) {
      generation.root.visible = false;
      this.#content = null;
      this.#releaseAliases();
    }
    this.#disposeGeneration(generation);
  }

  get numFrames(): number {
    return this.ready && this.numVerts && this.verts
      ? this.verts.length / (this.numVerts * 3)
      : 0;
  }

  setFrame(frame: number): void {
    this.setFrameFrac(frame);
  }

  setFrameFrac(frame: number): void {
    if (!this.ready || !this.mesh || !this.verts) return;
    const max = this.numFrames - 1;
    const firstFrame = Math.min(max, Math.floor(frame));
    const firstOffset = firstFrame * this.numVerts * 3;
    const positions = this.mesh.geometry.attributes.position;
    const blend = frame - firstFrame;
    if (blend <= 1e-5 || firstFrame >= max) {
      positions.array.set(
        this.verts.subarray(firstOffset, firstOffset + this.numVerts * 3),
      );
    } else {
      const secondOffset = (firstFrame + 1) * this.numVerts * 3;
      const destination = positions.array;
      const count = this.numVerts * 3;
      for (let index = 0; index < count; index++) {
        destination[index] =
          this.verts[firstOffset + index]
          + (this.verts[secondOffset + index] - this.verts[firstOffset + index])
          * blend;
      }
    }
    positions.needsUpdate = true;
  }

  async #prepareWithAuthority(
    bodyMesh: BodyMeshPayload | null | undefined,
    preparationIsCurrent: () => boolean,
  ): Promise<BakedMeshPreparationResult> {
    const authorityIsCurrent = (): boolean => {
      try {
        return preparationIsCurrent();
      } catch {
        return false;
      }
    };
    if (!authorityIsCurrent()) return { status: "stale" };

    let vertices: Float32Array | null = null;
    let geometry: THREE.BufferGeometry | null = null;
    let material: THREE.MeshStandardMaterial | null = null;
    let mesh: THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshStandardMaterial
    > | null = null;
    let root = new THREE.Group();
    root.visible = false;

    if (bodyMesh?.available) {
      try {
        vertices = await this.#decodeVertices(bodyMesh.vertices_gz_b64);
      } catch (error) {
        if (!authorityIsCurrent()) return { status: "stale" };
        // Current decode failure intentionally publishes an empty body so the
        // skeleton fallback remains usable.
        this.#reportWarningSafely("baked mesh decode failed", error);
        if (!authorityIsCurrent()) return { status: "stale" };
        vertices = null;
      }
      if (!authorityIsCurrent()) return { status: "stale" };

      if (vertices) {
        const expectedLength = bodyMesh.num_frames * bodyMesh.num_verts * 3;
        if (vertices.length !== expectedLength) {
          this.#reportWarningSafely(
            "baked mesh vertex buffer size mismatch",
            vertices.length,
            expectedLength,
          );
          if (!authorityIsCurrent()) return { status: "stale" };
          vertices = null;
        }
      }

      if (vertices) {
        try {
          geometry = new THREE.BufferGeometry();
          geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(vertices.slice(0, bodyMesh.num_verts * 3), 3),
          );
          geometry.setIndex(bodyMesh.triangles.flat());
          geometry.computeVertexNormals();
          material = new THREE.MeshStandardMaterial({
            color: 0xb4c8dc,
            roughness: 0.55,
            metalness: 0.05,
            side: THREE.DoubleSide,
            flatShading: true,
          });
          mesh = new THREE.Mesh(geometry, material);
          root.add(mesh);
        } catch (error) {
          this.#disposeDetachedRoot(root, geometry, material, mesh ? [mesh] : []);
          if (!authorityIsCurrent()) return { status: "stale" };
          this.#reportWarningSafely("baked mesh decode failed", error);
          if (!authorityIsCurrent()) return { status: "stale" };
          geometry = null;
          material = null;
          mesh = null;
          vertices = null;
          root = new THREE.Group();
          root.visible = false;
        }
      }
    }

    if (!authorityIsCurrent()) {
      this.#disposeDetachedRoot(root, geometry, material, mesh ? [mesh] : []);
      return { status: "stale" };
    }
    const ownedNodes = new Set<THREE.Object3D>();
    root.traverse((node) => { ownedNodes.add(node); });
    if (mesh) ownedNodes.add(mesh);
    const retirement = Object.freeze({}) as BakedMeshRetirement;
    const candidate: BakedMeshGeneration = {
      retirement,
      root,
      ownedNodes,
      mesh,
      vertices,
      numVerts: mesh && vertices && bodyMesh ? bodyMesh.num_verts : 0,
      geometry,
      material,
      retired: false,
    };
    this.#generations.set(retirement, candidate);
    return {
      status: "prepared",
      preparation: this.#createPreparation(candidate, authorityIsCurrent),
    };
  }

  #createPreparation(
    candidate: BakedMeshGeneration,
    preparationIsCurrent: () => boolean,
  ): PreparedBakedMesh {
    let state:
      | "prepared"
      | "staging"
      | "staged"
      | "published"
      | "abandoned" = "prepared";
    let stagedGeneration: number | null = null;
    const externalAuthorityIsCurrent = (isCurrent: () => boolean): boolean => {
      try {
        // The foreign callback sits between two local/domain checks so re-entry
        // from that callback always fails closed before entering Three.js.
        return preparationIsCurrent() && isCurrent() && preparationIsCurrent();
      } catch {
        return false;
      }
    };
    const abandon = (): void => {
      if (state === "published" || state === "abandoned") return;
      state = "abandoned";
      this.#disposeGeneration(candidate);
    };
    const stage = (
      isCurrent: () => boolean = () => true,
    ): BakedMeshStageDisposition => {
      if (state === "staged") return "staged";
      if (state !== "prepared") return "superseded";
      if (!externalAuthorityIsCurrent(isCurrent)) {
        this.#runStaleCleanup(abandon);
        return "superseded";
      }
      stagedGeneration = ++this.#stageGeneration;
      state = "staging";
      try {
        this.group.add(candidate.root);
      } catch (installError) {
        let cleanupError: unknown = null;
        try {
          abandon();
        } catch (error) {
          cleanupError = error;
        }
        if (
          stagedGeneration !== this.#stageGeneration
          || !externalAuthorityIsCurrent(isCurrent)
        ) {
          if (cleanupError) this.#reportWarningSafely("baked mesh cleanup failed", cleanupError);
          return "superseded";
        }
        if (cleanupError) {
          throw new AggregateError(
            [installError, cleanupError],
            "Baked mesh staging and cleanup failed",
          );
        }
        throw installError;
      }
      if (
        state !== "staging"
        || stagedGeneration !== this.#stageGeneration
        || candidate.root.parent !== this.group
        || !externalAuthorityIsCurrent(isCurrent)
      ) {
        this.#runStaleCleanup(abandon);
        return "superseded";
      }
      state = "staged";
      return "staged";
    };
    const canPublish = (): boolean => (
      state === "staged"
      && stagedGeneration === this.#stageGeneration
      && candidate.root.parent === this.group
    );
    const publish = (): BakedMeshRetirement | null => {
      // Deliberately no caller authority check: aggregate code performs its one
      // final check before entering a callback-free multi-View publication.
      if (!canPublish()) {
        throw new Error("Only the current staged baked mesh can publish");
      }
      state = "published";
      const retired = this.#content?.retirement ?? null;
      if (this.#content) this.#content.root.visible = false;
      candidate.root.visible = true;
      this.#content = candidate;
      this.mesh = candidate.mesh;
      this.verts = candidate.vertices;
      this.numVerts = candidate.numVerts;
      this.clipDuration = null;
      this.ready = Boolean(candidate.mesh && candidate.vertices);
      return retired;
    };
    const isPublishedCurrent = (): boolean => (
      state === "published" && this.#content === candidate
    );
    const commit = (
      isCurrent: () => boolean = () => true,
    ): AsyncStageViewLoadResult => {
      if (stage(isCurrent) !== "staged") return "stale";
      let retired: BakedMeshRetirement | null;
      try {
        retired = publish();
      } catch (error) {
        this.#runStaleCleanup(abandon);
        throw error;
      }
      try {
        this.retire(retired);
      } catch (error) {
        // Publication is already observable and cannot be rolled back. Cleanup
        // failure is diagnostic; report it, then describe the actual final View.
        this.#reportWarningSafely("baked mesh cleanup failed", error);
      }
      return (
        isPublishedCurrent()
        && externalAuthorityIsCurrent(isCurrent)
      ) ? "committed" : "stale";
    };
    return Object.freeze({
      stage,
      canPublish,
      publish,
      commit,
      abandon,
      isPublishedCurrent,
    });
  }

  #disposeGeneration(generation: BakedMeshGeneration): void {
    if (generation.retired) return;
    generation.retired = true;
    this.#generations.delete(generation.retirement);
    this.#disposeOwnedForest(
      generation.root,
      generation.ownedNodes,
      {
        geometries: generation.geometry ? [generation.geometry] : [],
        materials: generation.material ? [generation.material] : [],
      },
      "Baked mesh generation cleanup failed",
    );
  }

  /**
   * Terminally detach and dispose only one captured generation forest.
   *
   * Transfers completed before the terminal claim are preserved. Re-entry that
   * attaches a retired node beneath this View's successor is not a transfer and
   * is force-detached. Once claimed, every node is tombstoned before disposal,
   * and a dispose callback cannot resurrect it under either a local successor or
   * a foreign owner.
   */
  #disposeOwnedForest(
    retiredRoot: THREE.Object3D,
    nodesKnownBeforeAdoption: ReadonlySet<THREE.Object3D>,
    extras: {
      readonly geometries?: readonly THREE.BufferGeometry[];
      readonly materials?: readonly THREE.Material[];
    },
    context: string,
  ): void {
    const errors: unknown[] = [];
    const originalNodes = [...nodesKnownBeforeAdoption];
    const originalSet = new Set(originalNodes);
    originalSet.add(retiredRoot);

    const forceDetach = (node: THREE.Object3D): void => {
      const parent = node.parent;
      if (!parent) return;
      const index = parent.children.indexOf(node);
      if (index >= 0) parent.children.splice(index, 1);
      node.parent = null;
    };
    const detachFromStableOwner = (node: THREE.Object3D): void => {
      for (let attempt = 0; attempt < 2 && node.parent === this.group; attempt++) {
        try {
          this.group.remove(node);
        } catch (error) {
          errors.push(error);
        }
      }
      if (node.parent === this.group) forceDetach(node);
    };
    const isInStableRealm = (node: THREE.Object3D): boolean => {
      let current: THREE.Object3D | null = node;
      const seen = new Set<THREE.Object3D>();
      while (current && !seen.has(current)) {
        if (current === this.group) return true;
        seen.add(current);
        current = current.parent;
      }
      return false;
    };
    const topAncestor = (node: THREE.Object3D): THREE.Object3D => {
      let current = node;
      const seen = new Set<THREE.Object3D>();
      while (current.parent && !seen.has(current)) {
        seen.add(current);
        current = current.parent;
      }
      return current;
    };

    detachFromStableOwner(retiredRoot);
    // Removal observers may move any captured descendant or re-add the root.
    for (let pass = 0; pass < 3; pass++) {
      detachFromStableOwner(retiredRoot);
      for (const node of originalNodes) {
        if (node.parent === this.group) detachFromStableOwner(node);
      }
    }

    if (retiredRoot.parent && isInStableRealm(retiredRoot)) forceDetach(retiredRoot);
    for (const node of originalNodes) {
      if (node.parent && isInStableRealm(node)) forceDetach(node);
    }

    const terminalRootSet = new Set<THREE.Object3D>();
    const preservedRootSet = new Set<THREE.Object3D>();
    for (const node of [retiredRoot, ...originalNodes]) {
      const top = topAncestor(node);
      if (top.parent === null && originalSet.has(top)) terminalRootSet.add(top);
      else preservedRootSet.add(node);
    }
    const terminalRoots = [...terminalRootSet].filter((root) => {
      let parent = root.parent;
      while (parent) {
        if (terminalRootSet.has(parent)) return false;
        parent = parent.parent;
      }
      return true;
    });
    const claimedNodes = new Set<THREE.Object3D>();
    for (const root of terminalRoots) {
      root.traverse((node) => { claimedNodes.add(node); });
    }
    for (const node of claimedNodes) this.#terminalNodes.add(node);

    try {
      this.#resourceDisposer.disposeObject3DForest(terminalRoots, {
        ...extras,
        preserveRoots: [this.group, ...preservedRootSet],
      });
    } catch (error) {
      errors.push(error);
    }

    // Adoption after the tombstone cutoff can only expose disposed resources.
    for (const node of claimedNodes) {
      if (node.parent && !claimedNodes.has(node.parent)) forceDetach(node);
    }
    if (retiredRoot.parent === this.group) forceDetach(retiredRoot);
    if (errors.length > 0) throw new AggregateError(errors, context);
  }

  #disposeDetachedRoot(
    root: THREE.Group,
    geometry: THREE.BufferGeometry | null,
    material: THREE.MeshStandardMaterial | null,
    nodesKnownBeforeAdoption: readonly THREE.Object3D[] = [],
  ): void {
    const ownedNodes = new Set<THREE.Object3D>(nodesKnownBeforeAdoption);
    root.traverse((node) => { ownedNodes.add(node); });
    try {
      this.#disposeOwnedForest(
        root,
        ownedNodes,
        {
          geometries: geometry ? [geometry] : [],
          materials: material ? [material] : [],
        },
        "Detached baked mesh cleanup failed",
      );
    } catch (error) {
      // Detached async results have no synchronous owner that could recover a
      // cleanup error. Report it and never resurrect the candidate.
      this.#reportWarningSafely("baked mesh cleanup failed", error);
    }
  }

  #runStaleCleanup(cleanup: () => void): void {
    try {
      cleanup();
    } catch (error) {
      this.#reportWarningSafely("baked mesh cleanup failed", error);
    }
  }

  #releaseAliases(): void {
    this.mesh = null;
    this.verts = null;
    this.numVerts = 0;
    this.ready = false;
    this.clipDuration = null;
  }

  #reportWarningSafely(
    message: string,
    ...details: readonly unknown[]
  ): void {
    try {
      this.#reportWarning(message, ...details);
    } catch {
      // Reporting is observational and cannot change load ownership.
    }
  }
}
