// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import { ThreeResourceDisposer } from "../../../src/platform/graphics/common/three-resource-disposer";
import { LatestSessionLifecycle } from "../../../src/runtime/stage/latest-session-lifecycle";
import {
  ReferenceSkeletonView,
  type PreparedReferenceSkeleton,
  type ReferenceSkeletonLocalize,
  type ReferenceSkeletonResource,
  type ReferenceSkeletonRobotView,
} from "../../../src/runtime/stage/reference-skeleton-view";
import type { CalibrationReferencePayload } from "../../../src/runtime/types";

function referencePayload(): CalibrationReferencePayload {
  return {
    positions: [[
      [0, 0, 0],
      [0, 0, 1],
      [-1, 0, 1],
      [1, 0, 1],
    ]],
    parent_indices: [-1, 0, 1, 1],
    bone_names: ["pelvis", "torso", "left_arm", "right_arm"],
    canonical_names: ["hips", "chest", "left_shoulder", "right_shoulder"],
    quaternions: [[
      [0, 0, 0, 1],
      [0, 0, 0, 1],
      [0, 0, 0, 1],
      [0, 0, 0, 1],
    ]],
    color: 0x3366ff,
  };
}

function createHosts(): {
  readonly labelRoot: HTMLDivElement;
  readonly lineRoot: SVGSVGElement;
} {
  return {
    labelRoot: document.createElement("div"),
    lineRoot: document.createElementNS("http://www.w3.org/2000/svg", "svg"),
  };
}

function createView({
  localize = (english) => english,
  resourceDisposer = new ThreeResourceDisposer(),
}: {
  readonly localize?: ReferenceSkeletonLocalize;
  readonly resourceDisposer?: ThreeResourceDisposer;
} = {}) {
  const hosts = createHosts();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const view = new ReferenceSkeletonView({
    ...hosts,
    camera,
    localize,
    resourceDisposer,
  });
  return { view, camera, resourceDisposer, ...hosts };
}

function prepare(view: ReferenceSkeletonView): PreparedReferenceSkeleton {
  return view.prepare({
    payload: referencePayload(),
    ikMap: {
      left_shoulder: { t_body: "left_link" },
      right_shoulder: "right_link",
      missing_semantic: { target: "unused_link" },
    },
  });
}

function install(
  view: ReferenceSkeletonView,
  prepared = prepare(view),
): ReferenceSkeletonResource {
  let resource: ReferenceSkeletonResource | null = null;
  const authority = { isCurrent: () => true };
  expect(view.install({
    prepared,
    authority,
    mark: (candidate) => { resource = candidate; },
  })).toBe("installed");
  expect(resource).not.toBeNull();
  expect(view.project(resource!, true, authority)).toBe(true);
  return resource!;
}

function mappedRobotView({
  positions,
  quaternions = {},
}: {
  readonly positions: Readonly<Record<string, THREE.Vector3>>;
  readonly quaternions?: Readonly<Record<string, THREE.Quaternion>>;
}): ReferenceSkeletonRobotView {
  return {
    getLinkWorldPosition(link, out) {
      const position = positions[link];
      if (!position) return false;
      out.copy(position);
      return true;
    },
    getLinkWorldQuaternion(link, out) {
      const quaternion = quaternions[link];
      if (!quaternion) return false;
      out.copy(quaternion);
      return true;
    },
  };
}

interface HarnessState {
  readonly prepared: PreparedReferenceSkeleton;
  reference: ReferenceSkeletonResource | null;
}

function createSessionHarness(view: ReferenceSkeletonView) {
  const lifecycle = new LatestSessionLifecycle<"h2r", HarnessState>({
    cleanup: (session, authority) => {
      const state = session.value.value;
      const reference = state.reference;
      state.reference = null;
      if (reference) view.dispose(reference);
      view.project(null, false, { isCurrent: authority.isHandoffCurrent });
    },
  });
  const reserve = () => {
    const reservation = lifecycle.reserve("h2r", {
      prepared: prepare(view),
      reference: null,
    });
    if (reservation.kind !== "reserved") throw new Error("unexpected busy session");
    return reservation.session;
  };
  const start = (session: ReturnType<typeof reserve>): boolean => (
    lifecycle.start(session, (owned, authority) => {
      const state = owned.value.value;
      const disposition = view.install({
        prepared: state.prepared,
        authority,
        mark: (resource) => { state.reference = resource; },
      });
      if (disposition !== "installed" || !authority.isCurrent()) return;
      view.project(state.reference, true, authority);
    }) === "started"
  );
  return { lifecycle, reserve, start };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ReferenceSkeletonView", () => {
  it("keeps construction and preparation inert and rejects malformed input", () => {
    const { labelRoot, lineRoot } = createHosts();
    const labelSentinel = document.createElement("span");
    const lineSentinel = document.createElementNS("http://www.w3.org/2000/svg", "line");
    labelRoot.appendChild(labelSentinel);
    lineRoot.appendChild(lineSentinel);
    const localize = vi.fn<ReferenceSkeletonLocalize>((english) => english);
    const view = new ReferenceSkeletonView({
      labelRoot,
      lineRoot,
      camera: new THREE.PerspectiveCamera(),
      localize,
      resourceDisposer: new ThreeResourceDisposer(),
    });

    const prepared = prepare(view);
    expect(prepared.mappings).toHaveLength(2);
    expect(view.group.parent).toBeNull();
    expect(view.group.visible).toBe(false);
    expect(view.group.children).toHaveLength(0);
    expect(Array.from(labelRoot.childNodes)).toEqual([labelSentinel]);
    expect(Array.from(lineRoot.childNodes)).toEqual([lineSentinel]);
    expect(localize).not.toHaveBeenCalled();

    expect(() => view.prepare({
      payload: { ...referencePayload(), parent_indices: [-1, 8, 1, 1] },
      ikMap: {},
    })).toThrow("Reference parent 1 is out of range");
    expect(view.group.children).toHaveLength(0);
  });

  it("takes detached rollback before a failing cleanup so identities are tried once", () => {
    const disposer = new ThreeResourceDisposer();
    const cleanupFailure = new Error("detached GPU cleanup failed");
    const dispose = vi.spyOn(disposer, "disposeObject3DResources")
      .mockImplementation(() => { throw cleanupFailure; });
    const { view, labelRoot, lineRoot } = createView({ resourceDisposer: disposer });
    const mark = vi.fn();
    let authorityChecks = 0;

    expect(() => view.install({
      prepared: prepare(view),
      authority: { isCurrent: () => authorityChecks++ === 0 },
      mark,
    })).toThrow(cleanupFailure);
    expect(dispose).toHaveBeenCalledOnce();
    expect(mark).not.toHaveBeenCalled();
    expect(view.group.children).toHaveLength(0);
    expect(labelRoot.children).toHaveLength(0);
    expect(lineRoot.children).toHaveLength(0);
  });

  it("owns an empty exact resource without exposing an empty reference surface", () => {
    const { view, labelRoot, lineRoot } = createView();
    const prepared = view.prepare({ payload: null, ikMap: {} });
    const resource = install(view, prepared);
    const authority = { isCurrent: () => true };

    expect(view.facts(resource)).toMatchObject({
      available: false,
      visible: false,
      mappedLandmarks: 0,
    });
    expect(view.project(resource, true, authority)).toBe(true);
    expect(view.group.visible).toBe(false);
    expect(labelRoot.firstElementChild?.getAttribute("style")).toContain("display: none");
    expect(lineRoot.firstElementChild?.getAttribute("style")).toContain("display: none");

    view.dispose(resource);
    expect(view.group.children).toHaveLength(0);
    expect(labelRoot.children).toHaveLength(0);
    expect(lineRoot.children).toHaveLength(0);
    expect(() => view.dispose(resource)).not.toThrow();
  });

  it("builds exact geometry, mappings, display options, and diagnostics", () => {
    const localize = vi.fn<ReferenceSkeletonLocalize>((_english, chinese) => chinese);
    const { view, labelRoot, lineRoot } = createView({ localize });
    const world = new THREE.Group();
    world.rotation.z = Math.PI / 2;
    world.add(view.group);
    const resource = install(view);
    world.updateMatrixWorld(true);

    const facts = view.facts(resource)!;
    const meshes: THREE.Mesh[] = [];
    let lines: THREE.LineSegments | null = null;
    facts.object.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh);
      if ((node as THREE.LineSegments).isLineSegments) lines = node as THREE.LineSegments;
    });
    expect(facts).toMatchObject({ available: true, visible: true, mappedLandmarks: 2 });
    expect(meshes).toHaveLength(4);
    expect(new Set(meshes.map((mesh) => mesh.geometry)).size).toBe(1);
    expect(meshes.map((mesh) => mesh.position.toArray())).toEqual([
      [0, 0, 0],
      [0, 0, 1],
      [-1, 0, 1],
      [1, 0, 1],
    ]);
    expect(Array.from((lines!.geometry.getAttribute("position") as THREE.BufferAttribute).array))
      .toEqual([
        0, 0, 1, 0, 0, 0,
        -1, 0, 1, 0, 0, 1,
        1, 0, 1, 0, 0, 1,
      ]);
    expect(labelRoot.textContent).toContain("左肩 · left_link");
    expect(labelRoot.textContent).toContain("右肩 · right_link");
    expect(lineRoot.querySelectorAll("line")).toHaveLength(2);
    expect(localize).toHaveBeenCalledWith("Left shoulder", "左肩");

    expect(view.setDisplayOptions(resource, {
      mappedOnly: false,
      labels: false,
      mappingLines: false,
      sourceOpacity: 2,
    }, { isCurrent: () => true })).toBe(true);
    expect(meshes.every((mesh) => mesh.visible)).toBe(true);
    expect((labelRoot.firstElementChild as HTMLElement).style.display).toBe("none");
    expect((lineRoot.firstElementChild as SVGElement).style.display).toBe("none");

    const robotView = mappedRobotView({
      positions: {
        left_link: new THREE.Vector3(-1, 0, 1),
        right_link: new THREE.Vector3(1, 0, 1),
      },
      quaternions: {
        left_link: new THREE.Quaternion(),
        right_link: new THREE.Quaternion(),
      },
    });
    const diagnostics = view.diagnostics(resource, robotView, { isCurrent: () => true })!;
    expect(diagnostics.alignment).toHaveLength(2);
    for (const diagnostic of diagnostics.alignment) {
      expect(diagnostic.positionResidualM).toBeCloseTo(Math.SQRT2);
      expect(diagnostic.verticalResidualM).toBeCloseTo(0);
      expect(diagnostic.rotationResidualDeg).toBeCloseTo(90);
    }
    expect(diagnostics.headingResidualDeg).toBeCloseTo(90);
  });

  it("publishes the exact candidate before attach and removes a late predecessor", () => {
    const { view, labelRoot, lineRoot } = createView();
    const harness = createSessionHarness(view);
    const first = harness.reserve();
    let successor: typeof first | null = null;
    const originalAdd = view.group.add.bind(view.group);
    vi.spyOn(view.group, "add").mockImplementationOnce((...objects) => {
      expect(first.value.value.reference).not.toBeNull();
      expect(harness.lifecycle.stop(first)).toBe("stopped");
      successor = harness.reserve();
      expect(harness.start(successor)).toBe(true);
      return originalAdd(...objects);
    });

    expect(harness.start(first)).toBe(false);
    expect(successor).not.toBeNull();
    expect(harness.lifecycle.current).toBe(successor);
    expect(view.group.children).toEqual([
      view.facts(successor!.value.value.reference!)!.object,
    ]);
    expect(labelRoot.children).toHaveLength(1);
    expect(lineRoot.children).toHaveLength(1);
    expect(first.value.value.reference).toBeNull();
  });

  it("preserves a successor started reentrantly during exact GPU cleanup", () => {
    const { view, labelRoot, lineRoot } = createView();
    const harness = createSessionHarness(view);
    const first = harness.reserve();
    expect(harness.start(first)).toBe(true);
    const firstRoot = view.facts(first.value.value.reference!)!.object;
    const geometry = (firstRoot.children.find(
      (node) => (node as THREE.Mesh).isMesh,
    ) as THREE.Mesh).geometry;
    let successor: typeof first | null = null;
    geometry.addEventListener("dispose", () => {
      successor = harness.reserve();
      expect(harness.start(successor)).toBe(true);
    });

    expect(harness.lifecycle.stop(first)).toBe("stopped");
    expect(successor).not.toBeNull();
    expect(harness.lifecycle.current).toBe(successor);
    expect(view.group.children).toEqual([
      view.facts(successor!.value.value.reference!)!.object,
    ]);
    expect(labelRoot.children).toHaveLength(1);
    expect(lineRoot.children).toHaveLength(1);
  });

  it("tries every exact cleanup, flattens errors, and makes repeated dispose a no-op", () => {
    const disposer = new ThreeResourceDisposer();
    const { view, labelRoot, lineRoot } = createView({ resourceDisposer: disposer });
    const resource = install(view);
    const root = view.facts(resource)!.object;
    const groupFailure = new Error("group remove failed");
    const labelFailure = new Error("label remove failed");
    const gpuOne = new Error("geometry failed");
    const gpuTwo = new Error("material failed");
    const lineRemove = vi.spyOn(lineRoot.firstElementChild!, "remove");
    const clear = vi.spyOn(root, "clear");
    vi.spyOn(view.group, "remove").mockImplementation(() => {
      throw groupFailure;
    });
    vi.spyOn(labelRoot.firstElementChild!, "remove").mockImplementation(() => {
      throw labelFailure;
    });
    vi.spyOn(disposer, "disposeObject3DResources").mockImplementation(() => {
      throw new AggregateError([gpuOne, gpuTwo], "gpu failures");
    });

    let thrown: unknown;
    try {
      view.dispose(resource);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      groupFailure,
      labelFailure,
      gpuOne,
      gpuTwo,
    ]);
    expect(lineRemove).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(view.facts(resource)).toBeNull();
    expect(() => view.dispose(resource)).not.toThrow();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("makes stale read and mutation APIs harmless", () => {
    const { view } = createView();
    const resource = install(view);
    view.dispose(resource);
    const successor = install(view);
    const authority = { isCurrent: () => true };
    const robot = mappedRobotView({ positions: {} });

    expect(view.facts(resource)).toBeNull();
    expect(view.project(resource, true, authority)).toBe(false);
    expect(view.group.visible).toBe(true);
    expect(view.group.children).toEqual([view.facts(successor)!.object]);
    expect(view.setDisplayOptions(resource, { labels: false }, authority)).toBe(false);
    expect(view.refreshLabels(resource, authority)).toBe(false);
    expect(view.updateOverlay(resource, robot, authority)).toBe(false);
    expect(view.diagnostics(resource, robot, authority)).toBeNull();
  });
});
