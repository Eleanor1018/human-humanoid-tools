import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import type { BodyMeshPayload } from "../../../src/domain/motion/common/motion";
import { ThreeResourceDisposer } from "../../../src/platform/graphics/common/three-resource-disposer";
import {
  BakedMeshView,
  type BakedMeshWarningReporter,
} from "../../../src/runtime/stage/baked-mesh-view";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function bodyMesh(encodedVertices = "vertices"): BodyMeshPayload {
  return {
    available: true,
    vertices_gz_b64: encodedVertices,
    num_verts: 3,
    num_frames: 2,
    triangles: [[0, 1, 2]],
  };
}

function twoFrameVertices(offset = 0): Float32Array {
  return new Float32Array([
    offset + 0, 0, 0,
    offset + 1, 0, 0,
    offset + 0, 1, 0,
    offset + 0, 0, 1,
    offset + 1, 0, 1,
    offset + 0, 1, 1,
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BakedMeshView", () => {
  it("is inert until composition attaches its stable Group", () => {
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
    });

    expect(view.group.parent).toBeNull();
    expect(view.group.visible).toBe(false);
    expect(view.group.children).toHaveLength(0);
  });

  it("commits one decoded generation and preserves frame interpolation", async () => {
    const vertices = twoFrameVertices();
    const view = new BakedMeshView({
      decodeVertices: async () => vertices,
    });

    await expect(view.load(bodyMesh())).resolves.toBe("committed");

    expect(view.ready).toBe(true);
    expect(view.verts).toBe(vertices);
    expect(view.numVerts).toBe(3);
    expect(view.numFrames).toBe(2);
    expect(view.clipDuration).toBeNull();
    expect(view.group.children).toEqual([view.mesh]);

    view.setFrameFrac(0.5);
    expect(
      Array.from(view.mesh!.geometry.attributes.position.array),
    ).toEqual([
      0, 0, 0.5,
      1, 0, 0.5,
      0, 1, 0.5,
    ]);
  });

  it("lets a newer load win and ignores the older rejection", async () => {
    const first = deferred<Float32Array>();
    const second = deferred<Float32Array>();
    const reportWarning = vi.fn<BakedMeshWarningReporter>();
    const decodeVertices = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = new BakedMeshView({ decodeVertices, reportWarning });

    const staleLoad = view.load(bodyMesh("first"));
    const currentLoad = view.load(bodyMesh("second"));
    const currentVertices = twoFrameVertices(10);
    second.resolve(currentVertices);

    await expect(currentLoad).resolves.toBe("committed");
    const currentMesh = view.mesh;
    first.reject(new Error("late decoder failure"));
    await expect(staleLoad).resolves.toBe("stale");

    expect(decodeVertices).toHaveBeenNthCalledWith(1, "first");
    expect(decodeVertices).toHaveBeenNthCalledWith(2, "second");
    expect(reportWarning).not.toHaveBeenCalled();
    expect(view.ready).toBe(true);
    expect(view.verts).toBe(currentVertices);
    expect(view.mesh).toBe(currentMesh);
    expect(view.group.children).toEqual([currentMesh]);
  });

  it("does not let an older successful decode overwrite the current mesh", async () => {
    const first = deferred<Float32Array>();
    const second = deferred<Float32Array>();
    const decodeVertices = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = new BakedMeshView({ decodeVertices });

    const staleLoad = view.load(bodyMesh("first"));
    const currentLoad = view.load(bodyMesh("second"));
    const currentVertices = twoFrameVertices(20);
    second.resolve(currentVertices);
    await expect(currentLoad).resolves.toBe("committed");
    const currentMesh = view.mesh;

    first.resolve(twoFrameVertices(40));
    await expect(staleLoad).resolves.toBe("stale");

    expect(view.verts).toBe(currentVertices);
    expect(view.mesh).toBe(currentMesh);
    expect(view.group.children).toEqual([currentMesh]);
  });

  it("invalidates an escaped decoder without clearing stable content", async () => {
    const replacement = deferred<Float32Array>();
    const decodeVertices = vi
      .fn()
      .mockResolvedValueOnce(twoFrameVertices())
      .mockReturnValueOnce(replacement.promise);
    const view = new BakedMeshView({ decodeVertices });

    await view.load(bodyMesh("stable"));
    const stableMesh = view.mesh;
    const stableGeometry = stableMesh!.geometry;
    const stableMaterial = stableMesh!.material;
    const disposeGeometry = vi.spyOn(stableGeometry, "dispose");
    const disposeMaterial = vi.spyOn(stableMaterial, "dispose");

    const firstClaim = view.claimLoadGeneration();
    const secondClaim = view.claimLoadGeneration();

    expect(secondClaim).toBe(firstClaim + 1);
    expect(view.mesh).toBe(stableMesh);
    expect(view.group.children).toEqual([stableMesh]);
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(disposeMaterial).not.toHaveBeenCalled();

    const escapedLoad = view.load(bodyMesh("escaped"));
    view.claimLoadGeneration();
    replacement.resolve(twoFrameVertices(30));

    await expect(escapedLoad).resolves.toBe("stale");
    expect(view.mesh).toBeNull();
    expect(view.group.children).toHaveLength(0);
  });

  it("does not adopt a generation started re-entrantly during clear", async () => {
    const currentDecode = deferred<Float32Array>();
    const decodeVertices = vi.fn((encodedVertices: string) => {
      if (encodedVertices === "initial") {
        return Promise.resolve(twoFrameVertices());
      }
      if (encodedVertices === "current") return currentDecode.promise;
      throw new Error(`unexpected decode: ${encodedVertices}`);
    });
    const view = new BakedMeshView({ decodeVertices });
    await view.load(bodyMesh("initial"));
    const oldGeometry = view.mesh!.geometry;
    const oldMaterial = view.mesh!.material;
    const disposeGeometry = vi.spyOn(oldGeometry, "dispose");
    const disposeMaterial = vi.spyOn(oldMaterial, "dispose");
    let currentLoad: ReturnType<BakedMeshView["load"]> | undefined;
    const startCurrentLoad = () => {
      oldGeometry.removeEventListener("dispose", startCurrentLoad);
      currentLoad = view.load(bodyMesh("current"));
    };
    oldGeometry.addEventListener("dispose", startCurrentLoad);

    const staleLoad = view.load(bodyMesh("stale"));

    await expect(staleLoad).resolves.toBe("stale");
    expect(currentLoad).toBeDefined();
    expect(decodeVertices).not.toHaveBeenCalledWith("stale");
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();

    const currentVertices = twoFrameVertices(60);
    currentDecode.resolve(currentVertices);
    await expect(currentLoad!).resolves.toBe("committed");
    expect(view.verts).toBe(currentVertices);
    expect(view.group.children).toEqual([view.mesh]);
  });

  it("invalidates a pending decoder before clear releases every alias", async () => {
    const decoded = deferred<Float32Array>();
    const view = new BakedMeshView({
      decodeVertices: () => decoded.promise,
    });
    const pending = view.load(bodyMesh());

    view.clear();
    decoded.resolve(twoFrameVertices());

    await expect(pending).resolves.toBe("stale");
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.numVerts).toBe(0);
    expect(view.ready).toBe(false);
    expect(view.clipDuration).toBeNull();
  });

  it("disposes committed geometry and material exactly once when cleared", async () => {
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
    });
    await view.load(bodyMesh());
    const geometry = view.mesh!.geometry;
    const material = view.mesh!.material;
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");

    view.clear();

    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.numVerts).toBe(0);
    expect(view.ready).toBe(false);
    expect(view.clipDuration).toBeNull();
  });

  it("treats an unavailable body as a committed clear", async () => {
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
    });
    await view.load(bodyMesh());
    const disposeGeometry = vi.spyOn(view.mesh!.geometry, "dispose");
    const disposeMaterial = vi.spyOn(view.mesh!.material, "dispose");

    await expect(
      view.load({
        ...bodyMesh(),
        available: false,
      }),
    ).resolves.toBe("committed");

    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.numVerts).toBe(0);
    expect(view.ready).toBe(false);
  });

  it("releases aliases even when committed resource disposal reports failure", async () => {
    const failure = new Error("geometry listener failed");
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
    });
    await view.load(bodyMesh());
    vi.spyOn(view.mesh!.geometry, "dispose").mockImplementation(() => {
      throw failure;
    });
    const disposeMaterial = vi.spyOn(view.mesh!.material, "dispose");

    expect(() => view.clear()).toThrow(AggregateError);

    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.numVerts).toBe(0);
    expect(view.ready).toBe(false);
    expect(view.clipDuration).toBeNull();
  });

  it("keeps current decode and size failures as warning-only committed loads", async () => {
    const decodeFailure = new Error("invalid gzip");
    const decodeWarning = vi.fn<BakedMeshWarningReporter>();
    const decodeView = new BakedMeshView({
      decodeVertices: async () => {
        throw decodeFailure;
      },
      reportWarning: decodeWarning,
    });

    await expect(decodeView.load(bodyMesh())).resolves.toBe("committed");
    expect(decodeWarning).toHaveBeenCalledWith(
      "baked mesh decode failed",
      decodeFailure,
    );
    expect(decodeView.ready).toBe(false);

    const throwingWarningView = new BakedMeshView({
      decodeVertices: async () => {
        throw decodeFailure;
      },
      reportWarning: () => {
        throw new Error("warning reporter failed");
      },
    });
    await expect(throwingWarningView.load(bodyMesh())).resolves.toBe(
      "committed",
    );
    expect(throwingWarningView.ready).toBe(false);

    const sizeWarning = vi.fn<BakedMeshWarningReporter>();
    const sizeView = new BakedMeshView({
      decodeVertices: async () => new Float32Array([1, 2, 3]),
      reportWarning: sizeWarning,
    });

    await expect(sizeView.load(bodyMesh())).resolves.toBe("committed");
    expect(sizeWarning).toHaveBeenCalledWith(
      "baked mesh vertex buffer size mismatch",
      3,
      18,
    );
    expect(sizeView.group.children).toHaveLength(0);
    expect(sizeView.mesh).toBeNull();
    expect(sizeView.verts).toBeNull();
    expect(sizeView.numVerts).toBe(0);
    expect(sizeView.ready).toBe(false);
  });

  it("disposes detached GPU resources when the graph commit fails", async () => {
    const failure = new Error("added observer failed");
    const originalAdd = THREE.Object3D.prototype.add;
    vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    vi.spyOn(THREE.Material.prototype, "dispose");
    vi.spyOn(THREE.Object3D.prototype, "add").mockImplementationOnce(
      function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
        originalAdd.apply(this, objects);
        throw failure;
      },
    );
    const reportWarning = vi.fn<BakedMeshWarningReporter>();
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
      reportWarning,
    });

    await expect(view.load(bodyMesh())).resolves.toBe("committed");

    expect(reportWarning).toHaveBeenCalledWith(
      "baked mesh decode failed",
      failure,
    );
    expect(THREE.BufferGeometry.prototype.dispose).toHaveBeenCalledOnce();
    expect(THREE.Material.prototype.dispose).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.numVerts).toBe(0);
    expect(view.ready).toBe(false);
  });

  it("does not double-dispose a candidate cleared by a re-entrant added observer", async () => {
    const failure = new Error("observer failed after clear");
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
    });
    const originalAdd = THREE.Object3D.prototype.add;
    vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    vi.spyOn(THREE.Material.prototype, "dispose");
    vi.spyOn(THREE.Object3D.prototype, "add").mockImplementationOnce(
      function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
        originalAdd.apply(this, objects);
        view.clear();
        throw failure;
      },
    );

    await expect(view.load(bodyMesh())).resolves.toBe("stale");

    expect(THREE.BufferGeometry.prototype.dispose).toHaveBeenCalledOnce();
    expect(THREE.Material.prototype.dispose).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.ready).toBe(false);
  });

  it("keeps stale cleanup reporting observational when the reporter also fails", async () => {
    const cleanupFailure = new Error("detached cleanup failed");
    const reporterFailure = new Error("warning reporter failed");
    const disposer = new ThreeResourceDisposer();
    const disposeObject3DChildren = disposer.disposeObject3DChildren.bind(disposer);
    let disposalCall = 0;
    vi.spyOn(disposer, "disposeObject3DChildren").mockImplementation(
      (owner, extras) => {
        disposalCall += 1;
        disposeObject3DChildren(owner, extras);
        if (disposalCall === 3) throw cleanupFailure;
      },
    );
    const reportWarning = vi.fn<BakedMeshWarningReporter>(() => {
      throw reporterFailure;
    });
    let view!: BakedMeshView;
    vi.spyOn(
      THREE.BufferGeometry.prototype,
      "computeVertexNormals",
    ).mockImplementationOnce(() => {
      view.clear();
    });
    const disposeGeometry = vi.spyOn(
      THREE.BufferGeometry.prototype,
      "dispose",
    );
    const disposeMaterial = vi.spyOn(THREE.Material.prototype, "dispose");
    view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
      reportWarning,
      resourceDisposer: disposer,
    });

    await expect(view.load(bodyMesh())).resolves.toBe("stale");

    expect(reportWarning).toHaveBeenCalledOnce();
    expect(reportWarning).toHaveBeenCalledWith(
      "baked mesh cleanup failed",
      cleanupFailure,
    );
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.ready).toBe(false);
  });
});
