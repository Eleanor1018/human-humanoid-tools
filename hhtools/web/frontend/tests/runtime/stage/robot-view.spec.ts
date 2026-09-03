import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import type {
  Matrix4Data,
  RobotPayload,
  RobotTrajectoryPayload,
} from "../../../src/runtime/types";
import {
  RobotView,
  type RobotGltf,
  type RobotGltfParser,
  type RobotViewWarningReporter,
} from "../../../src/runtime/stage/robot-view";

const IDENTITY: Matrix4Data = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function robotPayload(
  name: string,
  {
    glb = true,
    links = [`${name}_link`],
    meshToLink = { mapped_mesh: links[0] },
  }: {
    glb?: boolean;
    links?: string[];
    meshToLink?: Record<string, string>;
  } = {},
): RobotPayload {
  return {
    name,
    display_name: name,
    links,
    mesh_to_link: meshToLink,
    link_transforms_zero: Object.fromEntries(
      links.map((link) => [link, [...IDENTITY] as Matrix4Data]),
    ),
    ground_offset_z: 0.125,
    glb_base64: glb ? btoa(name) : null,
  };
}

function gltfWithMesh(
  name = "mapped_mesh",
  geometry = new THREE.BufferGeometry(),
  material = new THREE.MeshStandardMaterial(),
): {
  gltf: RobotGltf;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
} {
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  const scene = new THREE.Group();
  scene.add(mesh);
  return {
    gltf: { scene, scenes: [scene] },
    mesh,
    geometry,
    material,
  };
}

async function advanceToParser(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RobotView", () => {
  it("is inert until composition attaches its stable Group", () => {
    const view = new RobotView();

    expect(view.group.parent).toBeNull();
    expect(view.group.visible).toBe(false);
    expect(view.group.children).toHaveLength(0);
  });

  it.each(["new-first", "old-first"] as const)(
    "lets the newest GLTF generation win when %s completes",
    async (completionOrder) => {
      const first = deferred<RobotGltf>();
      const second = deferred<RobotGltf>();
      const parseGltf = vi
        .fn<RobotGltfParser>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const view = new RobotView({ parseGltf });
      const firstGltf = gltfWithMesh();
      const secondGltf = gltfWithMesh();
      const disposeFirstGeometry = vi.spyOn(firstGltf.geometry, "dispose");
      const disposeFirstMaterial = vi.spyOn(firstGltf.material, "dispose");

      const staleLoad = view.load(robotPayload("first"));
      await advanceToParser();
      const currentLoad = view.load(robotPayload("second"));
      await advanceToParser();

      if (completionOrder === "new-first") {
        second.resolve(secondGltf.gltf);
        await expect(currentLoad).resolves.toBe("committed");
        first.resolve(firstGltf.gltf);
        await expect(staleLoad).resolves.toBe("stale");
      } else {
        first.resolve(firstGltf.gltf);
        await expect(staleLoad).resolves.toBe("stale");
        second.resolve(secondGltf.gltf);
        await expect(currentLoad).resolves.toBe("committed");
      }

      expect(view.links).toEqual(["second_link"]);
      expect(view.linkMeshes.second_link?.[0].mesh).toBe(secondGltf.mesh);
      expect(view.linkMeshes.first_link).toBeUndefined();
      expect(view.group.children).toHaveLength(1);
      expect(disposeFirstGeometry).toHaveBeenCalledOnce();
      expect(disposeFirstMaterial).toHaveBeenCalledOnce();
    },
  );

  it("invalidates a pending parse and disposes its late scene", async () => {
    const parsed = deferred<RobotGltf>();
    const view = new RobotView({ parseGltf: () => parsed.promise });
    const late = gltfWithMesh();
    const disposeGeometry = vi.spyOn(late.geometry, "dispose");
    const disposeMaterial = vi.spyOn(late.material, "dispose");
    const pending = view.load(robotPayload("pending"));
    await advanceToParser();

    view.clear();
    parsed.resolve(late.gltf);

    await expect(pending).resolves.toBe("stale");
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.links).toEqual([]);
  });

  it("settles a stale parse failure without creating a fallback", async () => {
    const parsed = deferred<RobotGltf>();
    const reportWarning = vi.fn<RobotViewWarningReporter>();
    const view = new RobotView({
      parseGltf: () => parsed.promise,
      reportWarning,
    });
    const pending = view.load(robotPayload("pending"));
    await advanceToParser();

    view.clear();
    parsed.reject(new Error("late parser failure"));

    await expect(pending).resolves.toBe("stale");
    expect(reportWarning).not.toHaveBeenCalled();
    expect(view.group.children).toHaveLength(0);
    expect(view.linkMeshes).toEqual({});
  });

  it("commits the link-skeleton fallback for a current parse failure", async () => {
    const failure = new Error("invalid glb");
    const reportWarning = vi.fn<RobotViewWarningReporter>();
    const view = new RobotView({
      parseGltf: async () => {
        throw failure;
      },
      reportWarning,
    });

    await expect(view.load(robotPayload("fallback"))).resolves.toBe("committed");

    expect(reportWarning).toHaveBeenCalledWith("robot GLTF parse failed", failure);
    expect(view.links).toEqual(["fallback_link"]);
    expect(view.linkMeshes.fallback_link).toHaveLength(1);
    expect(view.group.children).toHaveLength(1);
    expect(view.group.children[0].children).toEqual([
      view.linkMeshes.fallback_link[0].mesh,
    ]);
  });

  it("uses the fallback when a valid GLTF maps no meshes", async () => {
    const parsed = gltfWithMesh("unmapped_mesh");
    const view = new RobotView({ parseGltf: async () => parsed.gltf });

    await expect(view.load(robotPayload("fallback"))).resolves.toBe("committed");

    const fallback = view.linkMeshes.fallback_link[0].mesh;
    expect(fallback).not.toBe(parsed.mesh);
    expect(parsed.mesh.parent).toBe(parsed.gltf.scene);
    expect(view.group.children[0].children).toEqual([fallback]);
  });

  it("settles processing failures with a clean fallback and no half commit", async () => {
    const failure = new Error("normal generation failed");
    const parsed = gltfWithMesh();
    vi.spyOn(parsed.geometry, "computeVertexNormals").mockImplementation(() => {
      throw failure;
    });
    const disposeGeometry = vi.spyOn(parsed.geometry, "dispose");
    const disposeMaterial = vi.spyOn(parsed.material, "dispose");
    const reportWarning = vi.fn<RobotViewWarningReporter>();
    const view = new RobotView({
      parseGltf: async () => parsed.gltf,
      reportWarning,
    });

    await expect(view.load(robotPayload("processed"))).resolves.toBe("committed");

    expect(reportWarning).toHaveBeenCalledWith(
      "robot GLTF processing failed",
      failure,
    );
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.linkMeshes.processed_link[0].mesh).not.toBe(parsed.mesh);
    expect(view.group.children).toHaveLength(1);
  });

  it("guards graph attachment when an added observer clears the candidate", async () => {
    const parsed = gltfWithMesh();
    const disposeGeometry = vi.spyOn(parsed.geometry, "dispose");
    const disposeOldMaterial = vi.spyOn(parsed.material, "dispose");
    const view = new RobotView({ parseGltf: async () => parsed.gltf });
    const clearOnAttach = (): void => {
      view.group.removeEventListener("childadded", clearOnAttach);
      view.clear();
    };
    view.group.addEventListener("childadded", clearOnAttach);

    await expect(view.load(robotPayload("observed"))).resolves.toBe("stale");

    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeOldMaterial).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.links).toEqual([]);
    expect(view.linkMeshes).toEqual({});
  });

  it("disposes mapped, residual, replaced, and shared GLTF resources once", async () => {
    const sharedGeometry = new THREE.BufferGeometry();
    sharedGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    sharedGeometry.computeVertexNormals();
    const sharedTexture = new THREE.Texture();
    const originalMaterial = new THREE.MeshStandardMaterial({ map: sharedTexture });
    const mapped = new THREE.Mesh(sharedGeometry, originalMaterial);
    mapped.name = "mapped_mesh";
    const unmapped = new THREE.Mesh(sharedGeometry, originalMaterial);
    unmapped.name = "unmapped_mesh";
    const otherSceneMesh = new THREE.Mesh(sharedGeometry, originalMaterial);
    const scene = new THREE.Group();
    scene.add(mapped, unmapped);
    const otherScene = new THREE.Group();
    otherScene.add(otherSceneMesh);
    const gltf: RobotGltf = { scene, scenes: [scene, otherScene] };
    const disposeGeometry = vi.spyOn(sharedGeometry, "dispose");
    const disposeTexture = vi.spyOn(sharedTexture, "dispose");
    const disposeOldMaterial = vi.spyOn(originalMaterial, "dispose");
    const view = new RobotView({ parseGltf: async () => gltf });
    await view.load(robotPayload("owned"));
    const replacementMaterial = mapped.material as THREE.MeshStandardMaterial;
    const disposeReplacement = vi.spyOn(replacementMaterial, "dispose");

    view.clear();
    view.clear();

    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(disposeOldMaterial).toHaveBeenCalledOnce();
    expect(disposeReplacement).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
  });

  it("reserves a newer load started by a dispose listener", async () => {
    const initial = gltfWithMesh();
    const next = gltfWithMesh();
    const parseNext = deferred<RobotGltf>();
    const parseGltf = vi
      .fn<RobotGltfParser>()
      .mockResolvedValueOnce(initial.gltf)
      .mockReturnValueOnce(parseNext.promise);
    const view = new RobotView({ parseGltf });
    await view.load(robotPayload("initial"));
    const disposeInitialGeometry = vi.spyOn(initial.geometry, "dispose");
    let currentLoad: ReturnType<RobotView["load"]> | undefined;
    const startCurrentLoad = (): void => {
      initial.geometry.removeEventListener("dispose", startCurrentLoad);
      currentLoad = view.load(robotPayload("current"));
    };
    initial.geometry.addEventListener("dispose", startCurrentLoad);

    const staleLoad = view.load(robotPayload("stale", { glb: false }));
    await expect(staleLoad).resolves.toBe("stale");
    expect(currentLoad).toBeDefined();
    expect(disposeInitialGeometry).toHaveBeenCalledOnce();

    parseNext.resolve(next.gltf);
    await expect(currentLoad!).resolves.toBe("committed");
    expect(view.links).toEqual(["current_link"]);
    expect(view.linkMeshes.current_link[0].mesh).toBe(next.mesh);
  });

  it("settles stale when a throwing dispose listener starts a newer load", async () => {
    const initial = gltfWithMesh();
    const next = gltfWithMesh();
    const parseNext = deferred<RobotGltf>();
    const parseGltf = vi
      .fn<RobotGltfParser>()
      .mockResolvedValueOnce(initial.gltf)
      .mockReturnValueOnce(parseNext.promise);
    const view = new RobotView({ parseGltf });
    await view.load(robotPayload("initial"));
    let currentLoad: ReturnType<RobotView["load"]> | undefined;
    const cleanupFailure = new Error("dispose observer failed");
    const startCurrentLoad = (): void => {
      initial.geometry.removeEventListener("dispose", startCurrentLoad);
      currentLoad = view.load(robotPayload("current"));
      throw cleanupFailure;
    };
    initial.geometry.addEventListener("dispose", startCurrentLoad);

    const staleLoad = view.load(robotPayload("stale", { glb: false }));

    await expect(staleLoad).resolves.toBe("stale");
    expect(currentLoad).toBeDefined();
    parseNext.resolve(next.gltf);
    await expect(currentLoad!).resolves.toBe("committed");
    expect(view.links).toEqual(["current_link"]);
    expect(view.linkMeshes.current_link[0].mesh).toBe(next.mesh);
  });

  it("rejects a current cleanup failure only after releasing every alias", async () => {
    const initial = gltfWithMesh();
    const view = new RobotView({ parseGltf: async () => initial.gltf });
    await view.load(robotPayload("initial"));
    vi.spyOn(initial.geometry, "dispose").mockImplementation(() => {
      throw new Error("geometry cleanup failed");
    });

    await expect(
      view.load(robotPayload("replacement", { glb: false })),
    ).rejects.toThrow(AggregateError);

    expect(view.group.children).toHaveLength(0);
    expect(view.links).toEqual([]);
    expect(view.linkMeshes).toEqual({});
    expect(view.zero).toEqual({});
    expect(view.currentLinkTransforms).toEqual({});
    expect(view.trajectory).toBeNull();
  });

  it("lets callers detect when a rejected generation was superseded", async () => {
    const initial = gltfWithMesh();
    const current = gltfWithMesh();
    const parseCurrent = deferred<RobotGltf>();
    const parseGltf = vi
      .fn<RobotGltfParser>()
      .mockResolvedValueOnce(initial.gltf)
      .mockReturnValueOnce(parseCurrent.promise);
    const view = new RobotView({ parseGltf });
    await view.load(robotPayload("initial"));
    vi.spyOn(initial.geometry, "dispose").mockImplementation(() => {
      throw new Error("current generation cleanup failed");
    });

    const rejectedLoad = view.load(robotPayload("rejected", { glb: false }));
    const rejectedGeneration = view.loadGeneration;
    const currentLoad = view.load(robotPayload("current"));

    expect(view.isLoadGenerationCurrent(rejectedGeneration)).toBe(false);
    await expect(rejectedLoad).rejects.toThrow(AggregateError);
    await advanceToParser();
    parseCurrent.resolve(current.gltf);
    await expect(currentLoad).resolves.toBe("committed");
    expect(view.links).toEqual(["current_link"]);
  });

  it("lets callers detect when a committed generation is superseded before continuation", async () => {
    const view = new RobotView();
    const firstLoad = view.load(robotPayload("first", { glb: false }));
    const firstGeneration = view.loadGeneration;
    let secondLoad: ReturnType<RobotView["load"]> | undefined;

    // Register this continuation before awaiting the first load. It models a
    // newer user action winning the microtask race before the old caller can
    // publish the payload associated with its already-committed View state.
    const startSecond = firstLoad.then(() => {
      secondLoad = view.load(robotPayload("second", { glb: false }));
    });

    await expect(firstLoad).resolves.toBe("committed");
    expect(view.isLoadGenerationCurrent(firstGeneration)).toBe(false);
    await startSecond;
    expect(secondLoad).toBeDefined();
    await expect(secondLoad!).resolves.toBe("committed");
    expect(view.links).toEqual(["second_link"]);
  });

  it("clears every alias and transform while preserving external visibility", async () => {
    const view = new RobotView();
    const world = new THREE.Scene();
    world.add(view.group);
    await view.load(robotPayload("cleared", { glb: false }));
    const trajectory: RobotTrajectoryPayload = {
      frames: [
        {
          root: [2, 3, 4, 0, 0, 0, 1],
          links: { cleared_link: IDENTITY },
        },
      ],
      frame_indices: [4],
      playback_duration: 2,
    };
    view.setVisible(true);
    view.setTrajectory(trajectory);

    view.clear();

    expect(view.group.parent).toBe(world);
    expect(view.group.visible).toBe(true);
    expect(view.group.children).toHaveLength(0);
    expect(view.linkMeshes).toEqual({});
    expect(view.meshToLink).toEqual({});
    expect(view.zeroInv).toEqual({});
    expect(view.zero).toEqual({});
    expect(view.currentLinkTransforms).toEqual({});
    expect(view.links).toEqual([]);
    expect(view.trajectory).toBeNull();
    expect(view.frameIndices).toBeNull();
    expect(view.groundOffset).toBe(0);
    expect(view.clipDuration).toBe(1);
    expect(view.group.position.toArray()).toEqual([0, 0, 0]);
    expect(view.group.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(view.group.scale.toArray()).toEqual([1, 1, 1]);
  });
});
