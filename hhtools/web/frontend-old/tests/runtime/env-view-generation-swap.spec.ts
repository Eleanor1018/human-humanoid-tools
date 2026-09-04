import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import ts from "typescript";

import { ThreeResourceDisposer } from "../../src/platform/graphics/common/three-resource-disposer";
import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";

interface TestSceneObject {
  readonly positions: readonly (readonly [number, number, number])[];
  readonly quaternions: readonly (readonly [number, number, number, number])[];
}

interface TestEnvGeneration {
  readonly retirement: object;
  readonly root: THREE.Group;
  readonly ownedChildren: Set<THREE.Object3D>;
  readonly extras: object;
  retired: boolean;
  readonly objectMeshes: THREE.Object3D[];
  readonly objectTraj: TestSceneObject[];
  readonly motionToken: string;
  readonly clipDuration: number;
  activated: boolean;
}

interface TestEnvView {
  readonly group: THREE.Group;
  objectMeshes: THREE.Object3D[];
  objectTraj: TestSceneObject[];
  joints: TestSceneObject[] | null;
  clipDuration: number;
  content: TestEnvGeneration | null;
  commitObjectMesh(
    generation: TestEnvGeneration,
    object: TestSceneObject,
    index: number,
    placeholder: THREE.Object3D,
    real: THREE.Object3D,
  ): void;
}

function compileEnvView(): {
  readonly EnvView: new () => TestEnvView;
  readonly warnings: unknown[][];
} {
  const helpersStart = runtimeSource.indexOf("function errorMessage(");
  const helpersEnd = runtimeSource.indexOf("interface OrbitSettingsSnapshot");
  const classStart = runtimeSource.indexOf("class EnvView {");
  const classEnd = runtimeSource.indexOf(
    "interface RetirableThreeContentGeneration",
    classStart,
  );
  if ([helpersStart, helpersEnd, classStart, classEnd].some((index) => index < 0)) {
    throw new Error("EnvView test harness source boundary changed");
  }
  const source = [
    runtimeSource.slice(helpersStart, helpersEnd),
    runtimeSource.slice(classStart, classEnd),
  ].join("\n");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
  const warnings: unknown[][] = [];
  const testConsole = {
    warn: (...details: unknown[]) => { warnings.push(details); },
  };
  const stableOwner = new THREE.Group();
  const factory = new Function(
    "THREE",
    "env",
    "threeResourceDisposer",
    "GLTFLoader",
    "buildTerrainMesh",
    "effectivePlaybackDuration",
    "console",
    `${output}\nreturn EnvView;`,
  ) as (
    three: typeof THREE,
    env: THREE.Group,
    disposer: ThreeResourceDisposer,
    loader: new () => object,
    terrainBuilder: () => null,
    duration: () => number,
    consolePort: { warn(...details: unknown[]): void },
  ) => new () => TestEnvView;
  const EnvView = factory(
    THREE,
    stableOwner,
    new ThreeResourceDisposer(),
    class {},
    () => null,
    () => 1,
    testConsole,
  );
  return { EnvView, warnings };
}

function installStableGeneration(view: TestEnvView): {
  readonly generation: TestEnvGeneration;
  readonly object: TestSceneObject;
  readonly placeholder: THREE.Mesh;
} {
  const root = new THREE.Group();
  const placeholder = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
  );
  const object: TestSceneObject = {
    positions: [[0, 0, 0]],
    quaternions: [[0, 0, 0, 1]],
  };
  root.add(placeholder);
  view.group.add(root);
  const generation: TestEnvGeneration = {
    retirement: Object.freeze({}),
    root,
    ownedChildren: new Set([placeholder]),
    extras: {},
    retired: false,
    objectMeshes: [placeholder],
    objectTraj: [object],
    motionToken: "motion",
    clipDuration: 1,
    activated: true,
  };
  view.content = generation;
  view.objectMeshes = generation.objectMeshes;
  view.objectTraj = generation.objectTraj;
  view.joints = generation.objectTraj;
  return { generation, object, placeholder };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EnvView late GLTF generation swap", () => {
  it("rolls back a real subtree transferred by its added listener", () => {
    const { EnvView, warnings } = compileEnvView();
    const view = new EnvView();
    const { generation, object, placeholder } = installStableGeneration(view);
    const successorRoot = new THREE.Group();
    view.group.add(successorRoot);
    const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const material = new THREE.MeshBasicMaterial();
    const real = new THREE.Group();
    real.add(new THREE.Mesh(geometry, material));
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    let transferred = false;
    real.addEventListener("added", () => {
      if (transferred || real.parent !== generation.root) return;
      transferred = true;
      successorRoot.add(real);
    });

    view.commitObjectMesh(generation, object, 0, placeholder, real);

    expect(transferred).toBe(true);
    expect(generation.objectMeshes[0]).toBe(placeholder);
    expect(placeholder.parent).toBe(generation.root);
    expect(real.parent).toBeNull();
    expect(successorRoot.children).toHaveLength(0);
    expect(generation.ownedChildren.has(real)).toBe(false);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });

  it("keeps the placeholder authoritative when its removed listener re-adds it", () => {
    const { EnvView, warnings } = compileEnvView();
    const view = new EnvView();
    const { generation, object, placeholder } = installStableGeneration(view);
    const placeholderGeometry = placeholder.geometry;
    const disposePlaceholder = vi.spyOn(placeholderGeometry, "dispose");
    const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const material = new THREE.MeshBasicMaterial();
    const real = new THREE.Group();
    real.add(new THREE.Mesh(geometry, material));
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    placeholder.addEventListener("removed", () => {
      if (placeholder.parent === null) generation.root.add(placeholder);
    });

    view.commitObjectMesh(generation, object, 0, placeholder, real);

    expect(generation.objectMeshes[0]).toBe(placeholder);
    expect(view.objectMeshes[0]).toBe(placeholder);
    expect(placeholder.parent).toBe(generation.root);
    expect(real.parent).toBeNull();
    expect(generation.root.children).toEqual([placeholder]);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(disposePlaceholder).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});
