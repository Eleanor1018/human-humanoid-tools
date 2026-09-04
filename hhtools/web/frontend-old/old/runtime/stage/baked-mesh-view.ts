import * as THREE from "three";

import type { BodyMeshPayload } from "@/domain/motion/common/motion";
import { ThreeResourceDisposer } from "@/platform/graphics/common/three-resource-disposer";
import type { AsyncStageViewLoadResult } from "./async-stage-view-load-result";

export type BakedMeshDecoder = (encodedVertices: string) => Promise<Float32Array>;
export type BakedMeshWarningReporter = (
  message: string,
  ...details: readonly unknown[]
) => void;

export interface BakedMeshViewOptions {
  /** Injectable because browser decompression is asynchronous and non-cancellable. */
  readonly decodeVertices?: BakedMeshDecoder;
  readonly reportWarning?: BakedMeshWarningReporter;
  readonly resourceDisposer?: ThreeResourceDisposer;
}

/** Detached body candidate whose resources have exactly one terminal owner. */
export interface PreparedBakedMesh {
  /** Replace stable View content only while the caller still owns publication. */
  commit(isCurrent?: () => boolean): AsyncStageViewLoadResult;
  /** Release an uncommitted candidate; repeated terminal calls are neutral. */
  abandon(): void;
}

export type BakedMeshPreparationResult =
  | { readonly status: "prepared"; readonly preparation: PreparedBakedMesh }
  | { readonly status: "stale" };

interface BakedMeshCandidate {
  readonly generation: number;
  readonly mesh:
    | THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
    | null;
  readonly vertices: Float32Array | null;
  readonly numVerts: number;
  readonly geometry: THREE.BufferGeometry | null;
  readonly material: THREE.MeshStandardMaterial | null;
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
 * Construction is deliberately inert: composition decides which Scene/Group
 * owns `group`. Preparation builds detached resources while stable content
 * remains visible. The returned transaction commits once only while its
 * decoder generation and external publication owner are current, so a late
 * completion cannot replace resources owned by a newer motion.
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
  #clearing = false;
  #loadGeneration = 0;

  constructor(options: BakedMeshViewOptions = {}) {
    this.group.visible = false;
    this.#decodeVertices = options.decodeVertices ?? decodeGzipVertices;
    this.#reportWarning = options.reportWarning ?? defaultWarningReporter;
    this.#resourceDisposer = options.resourceDisposer ?? new ThreeResourceDisposer();
  }

  /**
   * Revoke an escaped decoder without clearing the currently committed mesh.
   *
   * A higher-level motion-selection owner calls this as soon as newer user
   * intent wins, which can happen before the replacement payload is available.
   * The old async continuation becomes stale immediately while the stable View
   * remains usable until that owner is ready to replace it.
   */
  claimLoadGeneration(): number {
    this.#loadGeneration += 1;
    return this.#loadGeneration;
  }

  clear(): void {
    // DecompressionStream exposes no cancellation handle. Invalidate first so
    // even a completion racing resource disposal observes a terminal generation.
    this.#loadGeneration += 1;
    // A dispose listener may synchronously start a newer load. It still gets a
    // fresh generation, while the outer clear remains the sole resource owner.
    if (this.#clearing) return;
    this.#clearing = true;
    try {
      this.#resourceDisposer.disposeObject3DChildren(this.group, {
        geometries: this.mesh ? [this.mesh.geometry] : [],
        materials: this.mesh ? [this.mesh.material] : [],
      });
    } finally {
      try {
        this.group.clear();
      } finally {
        // Aliases describe the same generation as the Group and must never
        // retain disposed resources, even if a dispose listener throws.
        this.mesh = null;
        this.verts = null;
        this.numVerts = 0;
        this.ready = false;
        this.clipDuration = null;
        this.#clearing = false;
      }
    }
  }

  /** Decode and build GPU resources without disturbing stable View content. */
  async prepare(
    bodyMesh: BodyMeshPayload | null | undefined,
  ): Promise<BakedMeshPreparationResult> {
    const generation = this.claimLoadGeneration();
    if (!bodyMesh?.available) {
      return {
        status: "prepared",
        preparation: this.#createPreparation({
          generation,
          mesh: null,
          vertices: null,
          numVerts: 0,
          geometry: null,
          material: null,
        }),
      };
    }

    let vertices: Float32Array;
    try {
      vertices = await this.#decodeVertices(bodyMesh.vertices_gz_b64);
    } catch (error) {
      if (!this.#isCurrent(generation)) return { status: "stale" };
      // A current decode failure preserves the skeleton fallback by preparing
      // an intentionally empty body generation.
      this.#reportWarningSafely("baked mesh decode failed", error);
      if (!this.#isCurrent(generation)) return { status: "stale" };
      return {
        status: "prepared",
        preparation: this.#createPreparation({
          generation,
          mesh: null,
          vertices: null,
          numVerts: 0,
          geometry: null,
          material: null,
        }),
      };
    }

    if (!this.#isCurrent(generation)) return { status: "stale" };
    const expectedLength = bodyMesh.num_frames * bodyMesh.num_verts * 3;
    if (vertices.length !== expectedLength) {
      this.#reportWarningSafely(
        "baked mesh vertex buffer size mismatch",
        vertices.length,
        expectedLength,
      );
      if (!this.#isCurrent(generation)) return { status: "stale" };
      return {
        status: "prepared",
        preparation: this.#createPreparation({
          generation,
          mesh: null,
          vertices: null,
          numVerts: 0,
          geometry: null,
          material: null,
        }),
      };
    }

    let geometry: THREE.BufferGeometry | null = null;
    let material: THREE.MeshStandardMaterial | null = null;
    let candidate: THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshStandardMaterial
    > | null = null;
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
      candidate = new THREE.Mesh(geometry, material);
    } catch (error) {
      this.#disposeDetached(candidate, geometry, material);
      if (!this.#isCurrent(generation)) return { status: "stale" };
      this.#reportWarningSafely("baked mesh decode failed", error);
      if (!this.#isCurrent(generation)) return { status: "stale" };
      return {
        status: "prepared",
        preparation: this.#createPreparation({
          generation,
          mesh: null,
          vertices: null,
          numVerts: 0,
          geometry: null,
          material: null,
        }),
      };
    }

    if (!this.#isCurrent(generation)) {
      this.#disposeDetached(candidate, geometry, material);
      return { status: "stale" };
    }
    return {
      status: "prepared",
      preparation: this.#createPreparation({
        generation,
        mesh: candidate,
        vertices,
        numVerts: bodyMesh.num_verts,
        geometry,
        material,
      }),
    };
  }

  async load(
    bodyMesh: BodyMeshPayload | null | undefined,
  ): Promise<AsyncStageViewLoadResult> {
    const result = await this.prepare(bodyMesh);
    return result.status === "stale"
      ? "stale"
      : result.preparation.commit();
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

  #createPreparation(candidate: BakedMeshCandidate): PreparedBakedMesh {
    let settled = false;
    return Object.freeze({
      commit: (isCurrent: () => boolean = () => true) => {
        if (settled) return "stale";
        settled = true;
        return this.#commitPrepared(candidate, isCurrent);
      },
      abandon: () => {
        if (settled) return;
        settled = true;
        this.#disposeDetached(
          candidate.mesh,
          candidate.geometry,
          candidate.material,
        );
      },
    });
  }

  #commitPrepared(
    candidate: BakedMeshCandidate,
    isCurrent: () => boolean,
  ): AsyncStageViewLoadResult {
    const externalIsCurrent = (): boolean => {
      try {
        return isCurrent();
      } catch {
        return false;
      }
    };
    // The external validator is a foreign callback. Check the local generation
    // both before and after it so synchronous re-entry fails closed.
    const ownsGeneration = (generation: number): boolean => (
      !this.#clearing
      && this.#isCurrent(generation)
      && externalIsCurrent()
      && !this.#clearing
      && this.#isCurrent(generation)
    );
    const disposeCandidate = (): void => {
      this.#disposeDetached(
        candidate.mesh,
        candidate.geometry,
        candidate.material,
      );
    };
    const detachAndDisposeCandidate = (): unknown | null => {
      let detachFailure: unknown | null = null;
      try {
        if (candidate.mesh?.parent === this.group) {
          this.group.remove(candidate.mesh);
        }
      } catch (error) {
        detachFailure = error;
      } finally {
        // Object3D.remove() dispatches synchronous events after detaching. A
        // faulty observer must never skip this transaction's terminal release.
        disposeCandidate();
      }
      return detachFailure;
    };
    if (!ownsGeneration(candidate.generation)) {
      disposeCandidate();
      return "stale";
    }

    // clear() claims a distinct commit generation. A disposal callback may
    // synchronously start a successor; the generation check below makes this
    // transaction abandon only its own detached candidate in that case.
    const commitGeneration = this.#loadGeneration + 1;
    try {
      this.clear();
    } catch (error) {
      disposeCandidate();
      // Candidate disposal is itself an observable host boundary. Re-check
      // after it so a successor started by a disposal listener owns the error.
      if (!ownsGeneration(commitGeneration)) return "stale";
      throw error;
    }
    if (!ownsGeneration(commitGeneration)) {
      disposeCandidate();
      return "stale";
    }
    if (!candidate.mesh || !candidate.vertices) {
      return ownsGeneration(commitGeneration) ? "committed" : "stale";
    }

    try {
      this.group.add(candidate.mesh);
      if (!ownsGeneration(commitGeneration)) {
        // A re-entrant clear may already have detached and disposed the mesh.
        if (candidate.mesh.parent === this.group) {
          const cleanupError = detachAndDisposeCandidate();
          if (cleanupError) {
            this.#reportWarningSafely("baked mesh cleanup failed", cleanupError);
          }
        }
        return "stale";
      }
    } catch (error) {
      if (candidate.mesh.parent === this.group) {
        const cleanupError = detachAndDisposeCandidate();
        if (cleanupError) {
          this.#reportWarningSafely("baked mesh cleanup failed", cleanupError);
        }
      } else if (ownsGeneration(commitGeneration)) {
        disposeCandidate();
      }
      if (!ownsGeneration(commitGeneration)) return "stale";
      this.#reportWarningSafely("baked mesh decode failed", error);
      return ownsGeneration(commitGeneration) ? "committed" : "stale";
    }

    // No fallible work remains after these aliases become observable.
    this.mesh = candidate.mesh;
    this.verts = candidate.vertices;
    this.numVerts = candidate.numVerts;
    this.clipDuration = null; // driven by the skeleton timeline
    this.ready = true;
    return "committed";
  }

  #isCurrent(generation: number): boolean {
    return this.#loadGeneration === generation;
  }

  #disposeDetached(
    candidate:
      | THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
      | null,
    geometry: THREE.BufferGeometry | null,
    material: THREE.MeshStandardMaterial | null,
  ): void {
    try {
      this.#resourceDisposer.disposeObject3DForest(
        candidate ? [candidate] : [],
        {
          geometries: geometry ? [geometry] : [],
          materials: material ? [material] : [],
        },
      );
    } catch (error) {
      // Detached async results have no synchronous owner that could recover a
      // cleanup error. Report it, finish terminalization, and never resurrect it.
      this.#reportWarningSafely("baked mesh cleanup failed", error);
    }
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
