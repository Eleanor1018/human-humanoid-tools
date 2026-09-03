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
 * owns `group`. Every load builds into locals and commits once, after the
 * decoder generation is still current, so a late completion cannot resurrect
 * resources cleared or replaced by a newer motion.
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

  async load(
    bodyMesh: BodyMeshPayload | null | undefined,
  ): Promise<AsyncStageViewLoadResult> {
    // Reserve this attempt before clear(): resource dispose listeners can
    // re-enter load(), and the outer attempt must not adopt their generation.
    const generation = this.#loadGeneration + 1;
    this.clear();
    if (!this.#isCurrent(generation)) return "stale";
    if (!bodyMesh?.available) return "committed";

    let vertices: Float32Array;
    try {
      vertices = await this.#decodeVertices(bodyMesh.vertices_gz_b64);
    } catch (error) {
      if (!this.#isCurrent(generation)) return "stale";
      // A current decode failure historically kept the skeleton presentation
      // usable. Preserve that compatibility while leaving this View empty.
      this.#reportWarningSafely("baked mesh decode failed", error);
      return "committed";
    }

    // The decoder may finish after clear() or another load(). Decoded CPU data
    // needs no disposal; simply refuse to construct GPU resources for it.
    if (!this.#isCurrent(generation)) return "stale";

    const expectedLength = bodyMesh.num_frames * bodyMesh.num_verts * 3;
    if (vertices.length !== expectedLength) {
      this.#reportWarningSafely(
        "baked mesh vertex buffer size mismatch",
        vertices.length,
        expectedLength,
      );
      return "committed";
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

      // Keep this final guard beside the graph commit. Today mesh construction
      // is synchronous, but the invariant survives future async build steps.
      if (!this.#isCurrent(generation)) {
        this.#disposeDetached(candidate, geometry, material);
        return "stale";
      }
      this.group.add(candidate);
      if (!this.#isCurrent(generation)) {
        // An `added` observer may synchronously clear the View. Only dispose a
        // candidate that still escaped that clear and remains attached here.
        if (candidate.parent === this.group) {
          this.group.remove(candidate);
          this.#disposeDetached(candidate, geometry, material);
        }
        return "stale";
      }
    } catch (error) {
      const stillCurrent = this.#isCurrent(generation);
      if (candidate?.parent === this.group) {
        this.group.remove(candidate);
        this.#disposeDetached(candidate, geometry, material);
      } else if (stillCurrent) {
        this.#disposeDetached(candidate, geometry, material);
      }
      // A re-entrant clear() can dispose and detach the candidate from an
      // `added` observer before that observer throws. In that stale case the
      // candidate has already crossed its terminal boundary; never dispose it
      // a second time from this escaped stack.
      if (!stillCurrent) return "stale";
      // Keep the legacy warning/fallback behavior for both decode and local
      // geometry-build failures; neither may leave a half-committed View.
      this.#reportWarningSafely("baked mesh decode failed", error);
      return "committed";
    }

    // No fallible work remains after these aliases become observable.
    this.mesh = candidate;
    this.verts = vertices;
    this.numVerts = bodyMesh.num_verts;
    this.clipDuration = null; // driven by the skeleton timeline
    this.ready = true;
    return "committed";
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

  #isCurrent(generation: number): boolean {
    return this.#loadGeneration === generation;
  }

  #disposeDetached(
    candidate: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null,
    geometry: THREE.BufferGeometry | null,
    material: THREE.MeshStandardMaterial | null,
  ): void {
    const owner = new THREE.Group();
    if (candidate) owner.add(candidate);
    try {
      this.#resourceDisposer.disposeObject3DChildren(owner, {
        geometries: geometry ? [geometry] : [],
        materials: material ? [material] : [],
      });
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
