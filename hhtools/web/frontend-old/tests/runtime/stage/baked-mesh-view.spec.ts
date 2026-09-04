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

function expectPublishedRoot(
  view: BakedMeshView,
  mesh: THREE.Object3D | null = view.mesh,
): THREE.Group {
  expect(view.group.children).toHaveLength(1);
  const root = view.group.children[0] as THREE.Group;
  expect(root.visible).toBe(true);
  expect(root.children).toEqual(mesh ? [mesh] : []);
  return root;
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
    expectPublishedRoot(view);

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
    expectPublishedRoot(view, currentMesh);
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
    expectPublishedRoot(view, currentMesh);
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
    expectPublishedRoot(view, stableMesh);
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(disposeMaterial).not.toHaveBeenCalled();

    const escapedLoad = view.load(bodyMesh("escaped"));
    view.claimLoadGeneration();
    replacement.resolve(twoFrameVertices(30));

    await expect(escapedLoad).resolves.toBe("stale");
    expect(view.mesh).toBe(stableMesh);
    expectPublishedRoot(view, stableMesh);
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(disposeMaterial).not.toHaveBeenCalled();
  });

  it("keeps stable content until a prepared replacement commits", async () => {
    const replacement = deferred<Float32Array>();
    const view = new BakedMeshView({
      decodeVertices: (encodedVertices) => encodedVertices === "stable"
        ? Promise.resolve(twoFrameVertices())
        : replacement.promise,
    });
    await view.load(bodyMesh("stable"));
    const stableMesh = view.mesh;
    const disposeGeometry = vi.spyOn(stableMesh!.geometry, "dispose");
    const disposeMaterial = vi.spyOn(stableMesh!.material, "dispose");

    const preparing = view.prepare(bodyMesh("replacement"));
    expect(view.mesh).toBe(stableMesh);
    expectPublishedRoot(view, stableMesh);

    const replacementVertices = twoFrameVertices(50);
    replacement.resolve(replacementVertices);
    const result = await preparing;
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("expected preparation");

    expect(view.mesh).toBe(stableMesh);
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(disposeMaterial).not.toHaveBeenCalled();
    expect(result.preparation.commit()).toBe("committed");

    const replacementMesh = view.mesh;
    expect(replacementMesh).not.toBe(stableMesh);
    expect(view.verts).toBe(replacementVertices);
    expectPublishedRoot(view, replacementMesh);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(result.preparation.commit()).toBe("stale");
    result.preparation.abandon();
    expect(view.mesh).toBe(replacementMesh);
  });

  it("stages a detached candidate without consulting local latest-load state", async () => {
    let authorityCalls = 0;
    let authorityThrows = false;
    const view = new BakedMeshView({
      decodeVertices: async (encodedVertices) => encodedVertices === "stable"
        ? twoFrameVertices()
        : twoFrameVertices(25),
    });
    await view.load(bodyMesh("stable"));
    const stableMesh = view.mesh;
    const stableRoot = expectPublishedRoot(view, stableMesh);
    const result = await view.prepareDetached(bodyMesh("candidate"), () => {
      authorityCalls += 1;
      if (authorityThrows) throw new Error("publish must not call authority");
      return true;
    });
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("expected preparation");

    view.claimLoadGeneration();
    expect(result.preparation.stage()).toBe("staged");
    expect(result.preparation.canPublish()).toBe(true);
    expect(view.mesh).toBe(stableMesh);
    expect(stableRoot.visible).toBe(true);
    expect(view.group.children).toHaveLength(2);
    const candidateRoot = view.group.children.find((root) => root !== stableRoot)!;
    expect(candidateRoot.visible).toBe(false);

    const callsBeforePublish = authorityCalls;
    authorityThrows = true;
    const retired = result.preparation.publish();
    expect(authorityCalls).toBe(callsBeforePublish);
    expect(result.preparation.canPublish()).toBe(false);
    expect(result.preparation.isPublishedCurrent()).toBe(true);
    expect(candidateRoot.visible).toBe(true);
    expect(stableRoot.visible).toBe(false);
    expect(view.verts).toEqual(twoFrameVertices(25));

    view.retire(retired);
    expectPublishedRoot(view);
  });

  it("abandons only the candidate when authority is lost during staging", async () => {
    let authority = true;
    const view = new BakedMeshView({
      decodeVertices: async (encodedVertices) => encodedVertices === "stable"
        ? twoFrameVertices()
        : twoFrameVertices(35),
    });
    await view.load(bodyMesh("stable"));
    const stableMesh = view.mesh;
    const stableRoot = expectPublishedRoot(view, stableMesh);
    const result = await view.prepareDetached(
      bodyMesh("candidate"),
      () => authority,
    );
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("expected preparation");
    const disposeGeometry = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const disposeMaterial = vi.spyOn(THREE.Material.prototype, "dispose");
    const originalAdd = THREE.Object3D.prototype.add;
    vi.spyOn(THREE.Object3D.prototype, "add").mockImplementation(
      function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
        const attached = originalAdd.apply(this, objects);
        if (this === view.group) authority = false;
        return attached;
      },
    );

    expect(result.preparation.stage()).toBe("superseded");
    result.preparation.abandon();

    expect(view.mesh).toBe(stableMesh);
    expect(view.group.children).toEqual([stableRoot]);
    expect(stableRoot.visible).toBe(true);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
  });

  it("does not expose publication from inside the staging attachment callback", async () => {
    const view = new BakedMeshView({
      decodeVertices: async (encodedVertices) => encodedVertices === "stable"
        ? twoFrameVertices()
        : twoFrameVertices(40),
    });
    await view.load(bodyMesh("stable"));
    const stableMesh = view.mesh;
    const result = await view.prepareDetached(bodyMesh("candidate"));
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("expected preparation");
    const originalAdd = THREE.Object3D.prototype.add;
    vi.spyOn(THREE.Object3D.prototype, "add").mockImplementation(
      function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
        const attached = originalAdd.apply(this, objects);
        if (this === view.group) {
          expect(objects[0].visible).toBe(false);
          expect(view.mesh).toBe(stableMesh);
          expect(() => result.preparation.publish()).toThrow(
            "Only the current staged baked mesh can publish",
          );
        }
        return attached;
      },
    );

    expect(result.preparation.stage()).toBe("staged");
    const retired = result.preparation.publish();
    view.retire(retired);
    expect(view.verts).toEqual(twoFrameVertices(40));
    expectPublishedRoot(view);
  });

  it("preflights false when later staging invalidates an earlier candidate", async () => {
    const view = new BakedMeshView({
      decodeVertices: async (encodedVertices) => {
        if (encodedVertices === "stable") return twoFrameVertices();
        if (encodedVertices === "first") return twoFrameVertices(42);
        return twoFrameVertices(44);
      },
    });
    await view.load(bodyMesh("stable"));
    const stableMesh = view.mesh;
    const stableRoot = expectPublishedRoot(view, stableMesh);
    const first = await view.prepareDetached(bodyMesh("first"));
    const second = await view.prepareDetached(bodyMesh("second"));
    expect(first.status).toBe("prepared");
    expect(second.status).toBe("prepared");
    if (first.status !== "prepared" || second.status !== "prepared") {
      throw new Error("expected preparations");
    }
    expect(first.preparation.stage()).toBe("staged");
    expect(first.preparation.canPublish()).toBe(true);
    const firstRoot = view.group.children.find((root) => root !== stableRoot)!;
    const originalAdd = THREE.Object3D.prototype.add;
    vi.spyOn(THREE.Object3D.prototype, "add").mockImplementation(
      function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
        const attached = originalAdd.apply(this, objects);
        if (this === view.group && objects[0] !== firstRoot) {
          first.preparation.abandon();
        }
        return attached;
      },
    );

    expect(second.preparation.stage()).toBe("staged");
    expect(first.preparation.canPublish()).toBe(false);
    expect(second.preparation.canPublish()).toBe(true);
    expect([
      first.preparation,
      second.preparation,
    ].every((preparation) => preparation.canPublish())).toBe(false);
    expect(view.mesh).toBe(stableMesh);
    expect(stableRoot.visible).toBe(true);

    first.preparation.abandon();
    second.preparation.abandon();
    expect(view.group.children).toEqual([stableRoot]);
    expectPublishedRoot(view, stableMesh);
  });

  it("retires exact predecessors across synchronous successor publication", async () => {
    const view = new BakedMeshView({
      decodeVertices: async (encodedVertices) => {
        if (encodedVertices === "stable") return twoFrameVertices();
        if (encodedVertices === "first") return twoFrameVertices(45);
        return twoFrameVertices(55);
      },
    });
    await view.load(bodyMesh("stable"));
    const stableGeometry = view.mesh!.geometry;
    const disposeStable = vi.spyOn(stableGeometry, "dispose");
    const first = await view.prepareDetached(bodyMesh("first"));
    const second = await view.prepareDetached(bodyMesh("second"));
    expect(first.status).toBe("prepared");
    expect(second.status).toBe("prepared");
    if (first.status !== "prepared" || second.status !== "prepared") {
      throw new Error("expected preparations");
    }
    expect(first.preparation.stage()).toBe("staged");
    const retiredStable = first.preparation.publish();
    const firstGeometry = view.mesh!.geometry;
    const disposeFirst = vi.spyOn(firstGeometry, "dispose");
    let secondGeometry: THREE.BufferGeometry | null = null;
    const publishSecond = () => {
      stableGeometry.removeEventListener("dispose", publishSecond);
      expect(second.preparation.stage()).toBe("staged");
      const retiredFirst = second.preparation.publish();
      secondGeometry = view.mesh!.geometry;
      view.retire(retiredFirst);
    };
    stableGeometry.addEventListener("dispose", publishSecond);

    view.retire(retiredStable);

    expect(disposeStable).toHaveBeenCalledOnce();
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(secondGeometry).not.toBeNull();
    expect(view.mesh!.geometry).toBe(secondGeometry);
    expect(view.verts).toEqual(twoFrameVertices(55));
    expectPublishedRoot(view);
  });

  it("detaches a retired root reinserted beneath its local successor", async () => {
    const view = new BakedMeshView({
      decodeVertices: async (encodedVertices) => encodedVertices === "stable"
        ? twoFrameVertices()
        : twoFrameVertices(65),
    });
    await view.load(bodyMesh("stable"));
    const stableRoot = expectPublishedRoot(view);
    const stableGeometry = view.mesh!.geometry;
    const disposeStable = vi.spyOn(stableGeometry, "dispose");
    const replacement = await view.prepareDetached(bodyMesh("replacement"));
    expect(replacement.status).toBe("prepared");
    if (replacement.status !== "prepared") throw new Error("expected preparation");
    expect(replacement.preparation.stage()).toBe("staged");
    const successorRoot = view.group.children.find((root) => root !== stableRoot)!;
    const retired = replacement.preparation.publish();
    stableRoot.addEventListener("removed", () => successorRoot.add(stableRoot));

    view.retire(retired);

    expect(stableRoot.parent).toBeNull();
    expect(successorRoot.children).toEqual([view.mesh]);
    expect(disposeStable).toHaveBeenCalledOnce();
    expectPublishedRoot(view);
  });

  it("tombstones retired nodes before a dispose callback can adopt them", async () => {
    const foreignOwner = new THREE.Group();
    const view = new BakedMeshView({
      decodeVertices: async (encodedVertices) => encodedVertices === "stable"
        ? twoFrameVertices()
        : twoFrameVertices(75),
    });
    await view.load(bodyMesh("stable"));
    const stableMesh = view.mesh!;
    const stableGeometry = stableMesh.geometry;
    const disposeStable = vi.spyOn(stableGeometry, "dispose");
    const replacement = await view.prepareDetached(bodyMesh("replacement"));
    expect(replacement.status).toBe("prepared");
    if (replacement.status !== "prepared") throw new Error("expected preparation");
    expect(replacement.preparation.stage()).toBe("staged");
    const retired = replacement.preparation.publish();
    stableGeometry.addEventListener("dispose", () => foreignOwner.add(stableMesh));

    view.retire(retired);

    expect(disposeStable).toHaveBeenCalledOnce();
    expect(stableMesh.parent).toBeNull();
    expect(foreignOwner.children).toHaveLength(0);
    expectPublishedRoot(view);
  });

  it("does not adopt a successor started re-entrantly during commit clear", async () => {
    const currentDecode = deferred<Float32Array>();
    const decodeVertices = vi.fn((encodedVertices: string) => {
      if (encodedVertices === "initial") {
        return Promise.resolve(twoFrameVertices());
      }
      if (encodedVertices === "stale") {
        return Promise.resolve(twoFrameVertices(30));
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

    const stalePreparation = await view.prepare(bodyMesh("stale"));
    expect(stalePreparation.status).toBe("prepared");
    if (stalePreparation.status !== "prepared") {
      throw new Error("expected preparation");
    }

    expect(stalePreparation.preparation.commit()).toBe("stale");
    expect(currentLoad).toBeDefined();
    expect(decodeVertices).toHaveBeenCalledWith("stale");
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();

    const currentVertices = twoFrameVertices(60);
    currentDecode.resolve(currentVertices);
    await expect(currentLoad!).resolves.toBe("committed");
    expect(view.verts).toBe(currentVertices);
    expectPublishedRoot(view);
  });

  it("rejects a prepared candidate committed from inside an active clear", async () => {
    const view = new BakedMeshView({
      decodeVertices: async (encodedVertices) => encodedVertices === "stable"
        ? twoFrameVertices()
        : twoFrameVertices(70),
    });
    await view.load(bodyMesh("stable"));
    const stableGeometry = view.mesh!.geometry;
    const prepared = await view.prepare(bodyMesh("candidate"));
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected preparation");
    const disposeGeometry = vi.spyOn(
      THREE.BufferGeometry.prototype,
      "dispose",
    );
    const disposeMaterial = vi.spyOn(THREE.Material.prototype, "dispose");
    let nestedCommit:
      | ReturnType<typeof prepared.preparation.commit>
      | null = null;
    const commitCandidate = () => {
      stableGeometry.removeEventListener("dispose", commitCandidate);
      nestedCommit = prepared.preparation.commit();
    };
    stableGeometry.addEventListener("dispose", commitCandidate);

    view.clear();

    expect(nestedCommit).toBe("stale");
    expect(disposeGeometry).toHaveBeenCalledTimes(2);
    expect(disposeMaterial).toHaveBeenCalledTimes(2);
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.ready).toBe(false);
  });

  it("rechecks its generation after a re-entrant publication validator", async () => {
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(80),
    });
    const prepared = await view.prepare(bodyMesh());
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected preparation");
    const disposeGeometry = vi.spyOn(
      THREE.BufferGeometry.prototype,
      "dispose",
    );
    const disposeMaterial = vi.spyOn(THREE.Material.prototype, "dispose");

    expect(prepared.preparation.commit(() => {
      view.claimLoadGeneration();
      return true;
    })).toBe("stale");

    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.ready).toBe(false);
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
    expectPublishedRoot(view, null);
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
    expectPublishedRoot(sizeView, null);
    expect(sizeView.mesh).toBeNull();
    expect(sizeView.verts).toBeNull();
    expect(sizeView.numVerts).toBe(0);
    expect(sizeView.ready).toBe(false);
  });

  it("disposes a staged candidate when stable-root attachment fails", async () => {
    const failure = new Error("added observer failed");
    const reportWarning = vi.fn<BakedMeshWarningReporter>();
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
      reportWarning,
    });
    const originalAdd = THREE.Object3D.prototype.add;
    vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    vi.spyOn(THREE.Material.prototype, "dispose");
    vi.spyOn(THREE.Object3D.prototype, "add").mockImplementation(
      function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
        const result = originalAdd.apply(this, objects);
        if (this === view.group) throw failure;
        return result;
      },
    );

    await expect(view.load(bodyMesh())).rejects.toBe(failure);

    expect(reportWarning).not.toHaveBeenCalled();
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

  it("disposes a stale candidate when its removed observer throws", async () => {
    const removalFailure = new Error("removed observer failed");
    const reportWarning = vi.fn<BakedMeshWarningReporter>();
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
      reportWarning,
    });
    const originalAdd = THREE.Object3D.prototype.add;
    vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    vi.spyOn(THREE.Material.prototype, "dispose");
    vi.spyOn(THREE.Object3D.prototype, "add").mockImplementation(
      function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
        if (this === view.group) {
          objects[0].addEventListener("removed", () => {
            throw removalFailure;
          });
          const result = originalAdd.apply(this, objects);
          view.claimLoadGeneration();
          return result;
        }
        return originalAdd.apply(this, objects);
      },
    );

    await expect(view.load(bodyMesh())).resolves.toBe("stale");

    expect(reportWarning).toHaveBeenCalledWith(
      "baked mesh cleanup failed",
      expect.any(AggregateError),
    );
    const reported = reportWarning.mock.calls[0][1] as AggregateError;
    expect(reported.errors).toContain(removalFailure);
    expect(THREE.BufferGeometry.prototype.dispose).toHaveBeenCalledOnce();
    expect(THREE.Material.prototype.dispose).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.ready).toBe(false);
  });

  it("abandons an uncommitted candidate exactly once", async () => {
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
    });
    const prepared = await view.prepare(bodyMesh());
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected preparation");
    const disposeGeometry = vi.spyOn(
      THREE.BufferGeometry.prototype,
      "dispose",
    );
    const disposeMaterial = vi.spyOn(THREE.Material.prototype, "dispose");

    prepared.preparation.abandon();
    prepared.preparation.abandon();
    expect(prepared.preparation.commit()).toBe("stale");

    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.ready).toBe(false);
  });

  it("keeps the published replacement when retired cleanup throws", async () => {
    const disposer = new ThreeResourceDisposer();
    const disposeForest = vi.spyOn(disposer, "disposeObject3DForest");
    const reportWarning = vi.fn<BakedMeshWarningReporter>();
    const view = new BakedMeshView({
      decodeVertices: async (encodedVertices) => encodedVertices === "stable"
        ? twoFrameVertices()
        : twoFrameVertices(90),
      resourceDisposer: disposer,
      reportWarning,
    });
    await view.load(bodyMesh("stable"));
    const prepared = await view.prepare(bodyMesh("candidate"));
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected preparation");
    vi.spyOn(view.mesh!.geometry, "dispose").mockImplementation(() => {
      throw new Error("stable geometry disposal failed");
    });

    expect(prepared.preparation.commit()).toBe("committed");

    expect(disposeForest).toHaveBeenCalledOnce();
    expect(reportWarning).toHaveBeenCalledWith(
      "baked mesh cleanup failed",
      expect.any(AggregateError),
    );
    expectPublishedRoot(view);
    expect(view.mesh).not.toBeNull();
    expect(view.verts).toEqual(twoFrameVertices(90));
    expect(view.ready).toBe(true);
  });

  it("keeps stale cleanup reporting observational when the reporter also fails", async () => {
    const cleanupFailure = new Error("detached cleanup failed");
    const reporterFailure = new Error("warning reporter failed");
    const disposer = new ThreeResourceDisposer();
    const disposeObject3DForest = disposer.disposeObject3DForest.bind(disposer);
    vi.spyOn(disposer, "disposeObject3DForest").mockImplementation(
      (roots, extras) => {
        disposeObject3DForest(roots, extras);
        throw cleanupFailure;
      },
    );
    const reportWarning = vi.fn<BakedMeshWarningReporter>(() => {
      throw reporterFailure;
    });
    const disposeGeometry = vi.spyOn(
      THREE.BufferGeometry.prototype,
      "dispose",
    );
    const disposeMaterial = vi.spyOn(THREE.Material.prototype, "dispose");
    const view = new BakedMeshView({
      decodeVertices: async () => twoFrameVertices(),
      reportWarning,
      resourceDisposer: disposer,
    });
    const prepared = await view.prepare(bodyMesh());
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected preparation");
    view.claimLoadGeneration();

    expect(prepared.preparation.commit()).toBe("stale");

    expect(reportWarning).toHaveBeenCalledOnce();
    expect(reportWarning).toHaveBeenCalledWith(
      "baked mesh cleanup failed",
      expect.any(AggregateError),
    );
    const reported = reportWarning.mock.calls[0][1] as AggregateError;
    expect(reported.errors).toContain(cleanupFailure);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.mesh).toBeNull();
    expect(view.verts).toBeNull();
    expect(view.ready).toBe(false);
  });
});
