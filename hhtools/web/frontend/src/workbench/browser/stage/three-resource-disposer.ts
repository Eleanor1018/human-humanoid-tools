import type {
  BufferGeometry,
  Material,
  Object3D,
  Scene,
  Skeleton,
  Texture,
} from "three";

export interface ThreeResourceExtras {
  readonly geometries?: readonly BufferGeometry[];
  readonly materials?: readonly Material[];
  readonly textures?: readonly Texture[];
}

interface CollectedThreeResources {
  readonly geometries: Set<BufferGeometry>;
  readonly materials: Set<Material>;
  readonly skeletons: Set<Skeleton>;
  readonly textures: Set<Texture>;
}

type Object3DWithRenderResources = Object3D & {
  readonly geometry?: unknown;
  readonly isBatchedMesh?: boolean;
  readonly isInstancedMesh?: boolean;
  readonly isScene?: boolean;
  readonly isSkinnedMesh?: boolean;
  readonly material?: unknown;
  readonly skeleton?: Skeleton;
};

type ShaderMaterialLike = Material & {
  readonly isShaderMaterial?: boolean;
  readonly uniforms?: Record<string, { readonly value?: unknown }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBufferGeometry(value: unknown): value is BufferGeometry {
  return (
    isObject(value) &&
    value.isBufferGeometry === true &&
    typeof value.dispose === "function"
  );
}

function isMaterial(value: unknown): value is Material {
  return (
    isObject(value) &&
    value.isMaterial === true &&
    typeof value.dispose === "function"
  );
}

function isTexture(value: unknown): value is Texture {
  return (
    isObject(value) &&
    value.isTexture === true &&
    typeof value.dispose === "function"
  );
}

function emptyCollection(): CollectedThreeResources {
  return {
    geometries: new Set(),
    materials: new Set(),
    skeletons: new Set(),
    textures: new Set(),
  };
}

/**
 * Releases the geometry, material, and texture resources used by the current
 * Stage's regular Mesh, Line, Sprite, Points, and SkinnedMesh object trees.
 *
 * Three.js deliberately does not dispose geometry, material, or texture when
 * an Object3D is removed. This helper discovers those resources without
 * mutating the scene graph and deduplicates shared identities within one
 * disposal pass. It never disposes Object3D, WebGLRenderer, controls,
 * observers, animation-frame handles, render targets, or light-owned render
 * maps; those remain the renderer owner's explicit responsibility.
 *
 * InstancedMesh and BatchedMesh have additional object-owned GPU allocations,
 * so this deliberately rejects them instead of performing an incomplete
 * cleanup. Add a dedicated owner path before either type enters the Stage.
 * Callers must invoke this only at a terminal ownership boundary: every live
 * alias must leave the render set in the same disposal pass.
 */
export class ThreeResourceDisposer {
  /** Dispose resources reachable from `root` without removing any nodes. */
  disposeObject3DResources(
    root: Object3D,
    extras: ThreeResourceExtras = {},
  ): void {
    const resources = emptyCollection();
    this.#collectObject3D(root, resources);
    this.#collectExtras(extras, resources);
    this.#disposeCollected(resources);
  }

  /**
   * Dispose every child subtree and empty `owner`, while preserving the stable
   * Group/Scene object that application state and visibility controls retain.
   */
  disposeObject3DChildren(
    owner: Object3D,
    extras: ThreeResourceExtras = {},
  ): void {
    const resources = emptyCollection();
    for (const child of owner.children) {
      this.#collectObject3D(child, resources);
    }
    this.#collectExtras(extras, resources);

    try {
      this.#disposeCollected(resources);
    } finally {
      // Resource-disposal errors must not leave disposed nodes attached to the
      // live scene. Object3D.clear() preserves `owner` and detaches children.
      owner.clear();
    }
  }

  /** Dispose detached materials (and their textures) during replacement. */
  disposeMaterials(materials: Material | readonly Material[]): void {
    const resources = emptyCollection();
    for (const material of Array.isArray(materials)
      ? materials
      : [materials]) {
      this.#collectMaterial(material, resources);
    }
    this.#disposeCollected(resources);
  }

  #collectObject3D(
    root: Object3D,
    resources: CollectedThreeResources,
  ): void {
    root.traverse((object) => {
      const candidate = object as Object3DWithRenderResources;
      if (candidate.isInstancedMesh || candidate.isBatchedMesh) {
        throw new Error(
          "InstancedMesh and BatchedMesh require dedicated Stage disposal",
        );
      }
      if (isBufferGeometry(candidate.geometry)) {
        resources.geometries.add(candidate.geometry);
      }
      this.#collectMaterialValue(candidate.material, resources);
      this.#collectMaterialValue(object.customDepthMaterial, resources);
      this.#collectMaterialValue(object.customDistanceMaterial, resources);

      // @types/three declares skeleton as present, but a real SkinnedMesh does
      // not receive it until bind(). Runtime guards are therefore required.
      if (candidate.isSkinnedMesh && candidate.skeleton) {
        resources.skeletons.add(candidate.skeleton);
        if (isTexture(candidate.skeleton.boneTexture)) {
          this.#collectTexture(candidate.skeleton.boneTexture, resources);
        }
      }

      if (candidate.isScene) {
        const scene = object as Scene;
        if (isTexture(scene.background)) {
          this.#collectTexture(scene.background, resources);
        }
        if (isTexture(scene.environment)) {
          this.#collectTexture(scene.environment, resources);
        }
        this.#collectMaterialValue(scene.overrideMaterial, resources);
      }
    });
  }

  #collectExtras(
    extras: ThreeResourceExtras,
    resources: CollectedThreeResources,
  ): void {
    for (const geometry of extras.geometries ?? []) {
      resources.geometries.add(geometry);
    }
    for (const material of extras.materials ?? []) {
      this.#collectMaterial(material, resources);
    }
    for (const texture of extras.textures ?? []) {
      this.#collectTexture(texture, resources);
    }
  }

  #collectMaterialValue(
    value: unknown,
    resources: CollectedThreeResources,
  ): void {
    if (Array.isArray(value)) {
      for (const candidate of value) {
        if (isMaterial(candidate)) this.#collectMaterial(candidate, resources);
      }
      return;
    }
    if (isMaterial(value)) this.#collectMaterial(value, resources);
  }

  #collectMaterial(
    material: Material,
    resources: CollectedThreeResources,
  ): void {
    if (resources.materials.has(material)) return;
    resources.materials.add(material);

    // Material.dispose() does not release referenced textures. Standard and
    // GLTF materials keep every texture slot as a direct enumerable property.
    for (const value of Object.values(material)) {
      if (isTexture(value)) {
        this.#collectTexture(value, resources);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (isTexture(item)) this.#collectTexture(item, resources);
        }
      }
    }

    const shader = material as ShaderMaterialLike;
    if (!shader.isShaderMaterial || !shader.uniforms) return;
    const visited = new WeakSet<object>();
    for (const uniform of Object.values(shader.uniforms)) {
      this.#collectUniformTextures(uniform?.value, resources, visited);
    }
  }

  #collectTexture(
    texture: Texture,
    resources: CollectedThreeResources,
  ): void {
    if (texture.isRenderTargetTexture || texture.renderTarget !== null) {
      throw new Error(
        "Render-target textures must be released through their target owner",
      );
    }
    resources.textures.add(texture);
  }

  #collectUniformTextures(
    value: unknown,
    resources: CollectedThreeResources,
    visited: WeakSet<object>,
  ): void {
    if (isTexture(value)) {
      this.#collectTexture(value, resources);
      return;
    }
    if (!isObject(value) || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        this.#collectUniformTextures(item, resources, visited);
      }
      return;
    }

    // Uniform structs are plain objects. Skipping class instances and typed
    // arrays avoids walking matrices, scene nodes, or host-owned objects.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    for (const item of Object.values(value)) {
      this.#collectUniformTextures(item, resources, visited);
    }
  }

  #disposeCollected(resources: CollectedThreeResources): void {
    const errors: unknown[] = [];
    this.#disposeEach(resources.geometries, errors);
    this.#disposeEach(resources.textures, errors);
    this.#disposeEach(resources.materials, errors);

    // Skeleton.dispose() in Three r185 merely disposes boneTexture itself. The
    // texture already went through the shared identity tracker above, so clear
    // each reference directly rather than disposing the same texture twice.
    for (const skeleton of resources.skeletons) skeleton.boneTexture = null;

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Failed to dispose every collected Three.js resource",
      );
    }
  }

  #disposeEach(
    resources: ReadonlySet<{ dispose(): void }>,
    errors: unknown[],
  ): void {
    for (const resource of resources) {
      try {
        resource.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
  }
}
