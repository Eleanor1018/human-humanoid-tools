// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import { ThreeResourceDisposer } from "../../../src/platform/graphics/common/three-resource-disposer";
import {
  ReferenceSkeletonView,
  type ReferenceSkeletonLocalize,
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
  const labelRoot = document.createElement("div");
  const lineRoot = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  return { labelRoot, lineRoot };
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
  return { view, camera, ...hosts };
}

function mappedRobotView({
  positions,
  quaternions = {},
}: {
  readonly positions: Readonly<Record<string, THREE.Vector3>>;
  readonly quaternions?: Readonly<Record<string, THREE.Quaternion>>;
}): ReferenceSkeletonRobotView {
  return {
    getLinkWorldPosition(link: string, out: THREE.Vector3): boolean {
      const position = positions[link];
      if (!position) return false;
      out.copy(position);
      return true;
    },
    getLinkWorldQuaternion(link: string, out: THREE.Quaternion): boolean {
      const quaternion = quaternions[link];
      if (!quaternion) return false;
      out.copy(quaternion);
      return true;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ReferenceSkeletonView", () => {
  it("is inert until composition attaches its stable Group", () => {
    const { labelRoot, lineRoot } = createHosts();
    const labelSentinel = document.createElement("span");
    const lineSentinel = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "line",
    );
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

    expect(view.group.parent).toBeNull();
    expect(view.group.visible).toBe(false);
    expect(view.group.children).toHaveLength(0);
    expect(Array.from(labelRoot.childNodes)).toEqual([labelSentinel]);
    expect(Array.from(lineRoot.childNodes)).toEqual([lineSentinel]);
    expect(localize).not.toHaveBeenCalled();
  });

  it("builds the legacy joint and segment geometry", () => {
    const { view } = createView();

    view.load(referencePayload());

    expect(view.group.visible).toBe(true);
    expect(view.spheres).toHaveLength(4);
    expect(view.group.children).toEqual([...view.spheres, view.lines]);
    expect(new Set(view.spheres.map((sphere) => sphere.geometry)).size).toBe(1);
    expect(view.spheres.map((sphere) => sphere.position.toArray())).toEqual([
      [0, 0, 0],
      [0, 0, 1],
      [-1, 0, 1],
      [1, 0, 1],
    ]);
    expect(
      Array.from(view.lineGeom!.getAttribute("position").array),
    ).toEqual([
      0, 0, 1, 0, 0, 0,
      -1, 0, 1, 0, 0, 1,
      1, 0, 1, 0, 0, 1,
    ]);
  });

  it("maps canonical landmarks and applies the legacy display options", () => {
    const localize = vi.fn<ReferenceSkeletonLocalize>((_english, chinese) => chinese);
    const { view, labelRoot, lineRoot } = createView({ localize });
    view.load(referencePayload());

    expect(view.configureMappings({
      left_shoulder: { t_body: "left_link" },
      right_shoulder: "right_link",
      missing_semantic: { target: "unused_link" },
    })).toBe(2);

    expect(view.mappings.map(({ semantic, targetLink, index }) => ({
      semantic,
      targetLink,
      index,
    }))).toEqual([
      { semantic: "left_shoulder", targetLink: "left_link", index: 2 },
      { semantic: "right_shoulder", targetLink: "right_link", index: 3 },
    ]);
    expect(labelRoot.textContent).toContain("左肩 · left_link");
    expect(labelRoot.textContent).toContain("右肩 · right_link");
    expect(lineRoot.querySelectorAll("line")).toHaveLength(2);
    expect(view.spheres[0].visible).toBe(false);
    expect(view.spheres[2].visible).toBe(true);
    expect(view.spheres[2].material).toBe(view.mappedMaterial);
    expect(view.spheres[2].scale.x).toBeCloseTo(1.12);

    view.setDisplayOptions({
      mappedOnly: false,
      labels: false,
      mappingLines: false,
      sourceOpacity: 2,
    });

    expect(view.spheres.every((sphere) => sphere.visible)).toBe(true);
    expect(view.spheres[0].material).toBe(view.contextMaterial);
    expect(view.spheres[0].scale.x).toBeCloseTo(0.62);
    expect(view.sourceOpacity).toBe(1);
    expect(view.mappedMaterial!.opacity).toBe(1);
    expect(view.contextMaterial!.opacity).toBeCloseTo(0.32);
    expect(view.lines!.material.opacity).toBeCloseTo(0.38);
    expect(labelRoot.style.display).toBe("none");
    expect(lineRoot.style.display).toBe("none");
    expect(localize).toHaveBeenCalledWith("Left shoulder", "左肩");
  });

  it("reports position, heading, and parent-world rotation diagnostics", () => {
    const { view } = createView();
    const world = new THREE.Group();
    world.rotation.z = Math.PI / 2;
    world.add(view.group);
    view.load(referencePayload());
    view.configureMappings({
      left_shoulder: "left_link",
      right_shoulder: "right_link",
    });
    world.updateMatrixWorld(true);

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

    const diagnostics = view.alignmentDiagnostics(robotView);
    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.positionResidualM).toBeCloseTo(Math.SQRT2);
      expect(diagnostic.verticalResidualM).toBeCloseTo(0);
      expect(diagnostic.rotationResidualDeg).toBeCloseTo(90);
    }
    expect(view.headingResidualDeg(robotView)).toBeCloseTo(90);
  });

  it("disposes each shared GPU identity once and releases every legacy alias", () => {
    const { view, labelRoot, lineRoot } = createView();
    view.load(referencePayload());
    view.configureMappings({ left_shoulder: "left_link" });

    const geometries = new Set<THREE.BufferGeometry>([
      ...view.spheres.map((sphere) => sphere.geometry),
      view.lineGeom!,
    ]);
    const materials = new Set<THREE.Material>([
      ...view.spheres.map((sphere) => sphere.material),
      view.lines!.material,
      view.mappedMaterial!,
      view.contextMaterial!,
    ]);
    const disposeSpies = [...geometries, ...materials].map((resource) => (
      vi.spyOn(resource, "dispose")
    ));

    view.clear();

    for (const dispose of disposeSpies) expect(dispose).toHaveBeenCalledOnce();
    expect(view.group.children).toHaveLength(0);
    expect(view.group.visible).toBe(false);
    expect(labelRoot.childNodes).toHaveLength(0);
    expect(lineRoot.childNodes).toHaveLength(0);
    expect(view.spheres).toEqual([]);
    expect(view.parents).toEqual([]);
    expect(view.boneNames).toEqual([]);
    expect(view.canonicalNames).toEqual([]);
    expect(view.referenceQuaternions).toEqual([]);
    expect(view.exclude.size).toBe(0);
    expect(view.mappings).toEqual([]);
    expect(view.lineGeom).toBeNull();
    expect(view.lines).toBeNull();
    expect(view.mappedMaterial).toBeNull();
    expect(view.contextMaterial).toBeNull();
  });

  it("terminalizes the graph, DOM roots, and aliases when disposal throws", () => {
    const disposer = new ThreeResourceDisposer();
    const { view, labelRoot, lineRoot } = createView({
      resourceDisposer: disposer,
    });
    view.load(referencePayload());
    view.configureMappings({ left_shoulder: "left_link" });
    const failure = new Error("dispose failed");
    vi.spyOn(disposer, "disposeObject3DChildren").mockImplementation(() => {
      throw failure;
    });

    expect(() => view.clear()).toThrow(failure);

    expect(view.group.children).toHaveLength(0);
    expect(view.group.visible).toBe(false);
    expect(labelRoot.childNodes).toHaveLength(0);
    expect(lineRoot.childNodes).toHaveLength(0);
    expect(view.spheres).toEqual([]);
    expect(view.parents).toEqual([]);
    expect(view.mappings).toEqual([]);
    expect(view.lineGeom).toBeNull();
    expect(view.lines).toBeNull();
    expect(view.mappedMaterial).toBeNull();
    expect(view.contextMaterial).toBeNull();
  });
});
