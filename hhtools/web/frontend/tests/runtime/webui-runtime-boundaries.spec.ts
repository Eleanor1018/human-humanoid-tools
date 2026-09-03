import { describe, expect, it } from "vitest";

import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";
import commandRegistrySource from "../../src/runtime/command-registry.ts?raw";

describe("legacy runtime ownership boundaries", () => {
  it("invalidates async environment loads and disposes stale GLTF scenes", () => {
    const terrainBuilder = runtimeSource.slice(
      runtimeSource.indexOf("function buildTerrainMesh"),
      runtimeSource.indexOf("// Ground grid"),
    );
    expect(terrainBuilder).toContain(
      "materialParameters: THREE.MeshStandardMaterialParameters",
    );
    expect(terrainBuilder).toContain(
      "new THREE.MeshStandardMaterial(materialParameters)",
    );

    const detachedDisposal = runtimeSource.slice(
      runtimeSource.indexOf("function disposeDetachedThreeObject"),
      runtimeSource.indexOf("interface OrbitSettingsSnapshot"),
    );
    expect(detachedDisposal).toContain(
      "threeResourceDisposer.disposeObject3DResources(object)",
    );
    expect(detachedDisposal).toContain("console.warn(context, errorMessage(error))");

    const environmentViews = [
      {
        className: "EnvView",
        endMarker: "class ScaledEnvView",
        invocation: "this._buildObject(o, i, motion.token, generation)",
        staleContext: "stale environment GLTF cleanup failed",
        placeholderContext: "environment placeholder cleanup failed",
        clearedAliases: [
          "this.objectMeshes = []",
          "this.objectTraj = []",
          "this.joints = null",
          "this.clipDuration = 1",
        ],
      },
      {
        className: "ScaledEnvView",
        endMarker: "// =================================================================  BODY MESH",
        invocation: "this._buildObject(o, i, generation)",
        staleContext: "stale scaled-environment GLTF cleanup failed",
        placeholderContext: "scaled-environment placeholder cleanup failed",
        clearedAliases: [
          "this.objectMeshes = []",
          "this.objectTraj = []",
          "this.joints = null",
          "this.motionToken = null",
          "this._objectGlbUrl = null",
          "this.clipDuration = 1",
        ],
      },
    ] as const;

    for (const view of environmentViews) {
      const classStart = runtimeSource.indexOf(`class ${view.className}`);
      const classEnd = runtimeSource.indexOf(view.endMarker, classStart);
      const classSource = runtimeSource.slice(classStart, classEnd);
      expect(classStart, `${view.className} start`).toBeGreaterThanOrEqual(0);
      expect(classEnd, `${view.className} end`).toBeGreaterThan(classStart);
      expect(classSource).toContain("private _loadGeneration = 0");
      if (view.className === "ScaledEnvView") {
        expect(classSource).toContain("const m = buildTerrainMesh(");
        expect(classSource).toContain("color: 0x5c7a9e");
        expect(classSource).not.toContain("m.material =");
      }

      const clearStart = classSource.indexOf("clear(): void {");
      const loadStart = classSource.indexOf("\n  load(", clearStart);
      const clearSource = classSource.slice(clearStart, loadStart);
      expect(clearSource).toContain("this._loadGeneration += 1");
      expect(clearSource).toContain(
        "threeResourceDisposer.disposeObject3DChildren(this.group)",
      );
      expect(clearSource).toContain("finally {");
      expect(clearSource).toContain("this.group.clear()");
      for (const alias of view.clearedAliases) {
        expect(clearSource, `${view.className}: ${alias}`).toContain(alias);
      }
      expect(clearSource).not.toContain("while (this.group.children.length)");

      const buildStart = classSource.indexOf("private _buildObject", loadStart);
      const loadSource = classSource.slice(loadStart, buildStart);
      const buildSource = classSource.slice(buildStart);
      expect(loadSource).toContain("const generation = this._loadGeneration");
      expect(loadSource).toContain(view.invocation);
      expect(buildSource).toContain("generation: number");

      const staleCheck = buildSource.indexOf(
        "this._loadGeneration !== generation",
      );
      const identityCheck = buildSource.indexOf(
        "this.objectMeshes[i] !== box",
        staleCheck,
      );
      const staleDispose = buildSource.indexOf(view.staleContext, identityCheck);
      const staleReturn = buildSource.indexOf("return;", staleDispose);
      const attach = buildSource.indexOf("this.group.add(real)", staleReturn);
      const publish = buildSource.indexOf("this.objectMeshes[i] = real", attach);
      const detachPlaceholder = buildSource.indexOf("this.group.remove(box)", publish);
      const disposePlaceholder = buildSource.indexOf(
        view.placeholderContext,
        detachPlaceholder,
      );
      expect(staleCheck, `${view.className} generation guard`).toBeGreaterThanOrEqual(0);
      expect(identityCheck, `${view.className} placeholder guard`).toBeGreaterThan(staleCheck);
      expect(staleDispose, `${view.className} stale disposal`).toBeGreaterThan(identityCheck);
      expect(staleReturn, `${view.className} stale return`).toBeGreaterThan(staleDispose);
      expect(attach, `${view.className} attach`).toBeGreaterThan(staleReturn);
      expect(publish, `${view.className} publish`).toBeGreaterThan(attach);
      expect(detachPlaceholder, `${view.className} placeholder detach`).toBeGreaterThan(publish);
      expect(disposePlaceholder, `${view.className} placeholder disposal`).toBeGreaterThan(
        detachPlaceholder,
      );
    }
  });

  it("terminally disposes synchronous Stage View children before clearing aliases", () => {
    expect(runtimeSource).toContain(
      'import { ThreeResourceDisposer } from "@/platform/graphics/common/three-resource-disposer"',
    );
    expect(runtimeSource).toContain(
      "const threeResourceDisposer = new ThreeResourceDisposer()",
    );

    const synchronousViews = [
      {
        className: "SkeletonView",
        nextClassName: "ReferenceSkeletonView",
        inventory: [
          "...this.spheres.map((sphere) => sphere.geometry)",
          "...(this.lineGeom ? [this.lineGeom] : [])",
          "...this.spheres.map((sphere) => sphere.material)",
          "...(this.lines ? [this.lines.material] : [])",
        ],
        cleanup: ["this.group.clear()"],
        aliasReleases: [
          "this.lineGeom = null",
          "this.lines = null",
          "this.spheres = []",
          "this.joints = null",
          "this.parents = []",
          "this.frameIndices = null",
          "this.exclude = new Set()",
        ],
      },
      {
        className: "ReferenceSkeletonView",
        nextClassName: "EnvView",
        inventory: [
          "...this.spheres.map((sphere) => sphere.geometry)",
          "...(this.lineGeom ? [this.lineGeom] : [])",
          "...this.spheres.map((sphere) => sphere.material)",
          "...(this.lines ? [this.lines.material] : [])",
          "...(this.mappedMaterial ? [this.mappedMaterial] : [])",
          "...(this.contextMaterial ? [this.contextMaterial] : [])",
        ],
        cleanup: [
          "this.group.clear()",
          "this.labelRoot.replaceChildren()",
          "this.lineRoot.replaceChildren()",
        ],
        aliasReleases: [
          "this.lineGeom = null",
          "this.lines = null",
          "this.mappedMaterial = null",
          "this.contextMaterial = null",
          "this.spheres = []",
          "this.parents = []",
          "this.boneNames = []",
          "this.canonicalNames = []",
          "this.referenceQuaternions = []",
          "this.exclude = new Set()",
          "this.mappings = []",
          "this.group.visible = false",
        ],
      },
      {
        className: "CapsuleMeshView",
        nextClassName: "ScaledSkeletonView",
        inventory: [
          "geometries: this.mesh ? [this.mesh.geometry] : []",
          "materials: this.mesh ? [this.mesh.material] : []",
        ],
        cleanup: ["this.group.clear()"],
        aliasReleases: [
          "this.mesh = null",
          "this.joints = null",
          "this.frameIndices = null",
          "this.edges = []",
          "this.visibleJoints = []",
          "this.numJoints = 0",
          "this.positions = new Float32Array()",
        ],
      },
      {
        className: "ScaledSkeletonView",
        nextClassName: "BakedMeshView",
        inventory: [
          "...this.spheres.map((sphere) => sphere.geometry)",
          "...(this.lineGeom ? [this.lineGeom] : [])",
          "...this.spheres.map((sphere) => sphere.material)",
          "...(this.lines ? [this.lines.material] : [])",
        ],
        cleanup: ["this.group.clear()"],
        aliasReleases: [
          "this.lineGeom = null",
          "this.lines = null",
          "this.spheres = []",
          "this.joints = null",
          "this.parents = []",
          "this.frameIndices = null",
        ],
      },
    ] as const;

    for (const {
      className,
      nextClassName,
      inventory,
      cleanup,
      aliasReleases,
    } of synchronousViews) {
      const classStart = runtimeSource.indexOf(`class ${className}`);
      const classEnd = runtimeSource.indexOf(
        `class ${nextClassName}`,
        classStart,
      );
      const classSource = runtimeSource.slice(classStart, classEnd);
      const clearStart = classSource.indexOf("clear(): void {");
      const clearEnd = classSource.indexOf("\n  load(", clearStart);
      const clearSource = classSource.slice(clearStart, clearEnd);

      expect(classStart, `${className} start`).toBeGreaterThanOrEqual(0);
      expect(classEnd, `${className} end`).toBeGreaterThan(classStart);
      expect(clearStart, `${className}.clear start`).toBeGreaterThanOrEqual(0);
      expect(clearEnd, `${className}.clear end`).toBeGreaterThan(clearStart);
      const disposal = clearSource.indexOf(
        "threeResourceDisposer.disposeObject3DChildren(this.group",
      );
      const finallyBlock = clearSource.indexOf("finally {");
      expect(disposal, `${className} disposal`).toBeGreaterThanOrEqual(0);
      expect(finallyBlock, `${className} finally`).toBeGreaterThan(disposal);
      expect(clearSource).not.toContain("while (this.group.children.length)");

      const disposalSource = clearSource.slice(disposal, finallyBlock);
      for (const ownedResource of inventory) {
        expect(disposalSource, `${className}: ${ownedResource}`).toContain(
          ownedResource,
        );
      }

      // One outer finally enters cleanup; one nested finally per fallible
      // cleanup guarantees the alias-release block remains reachable.
      expect(clearSource.match(/finally \{/g)).toHaveLength(cleanup.length + 1);
      let previousCleanup = finallyBlock;
      for (const cleanupCall of cleanup) {
        const cleanupIndex = clearSource.indexOf(
          cleanupCall,
          previousCleanup + 1,
        );
        expect(cleanupIndex, `${className}: ${cleanupCall}`).toBeGreaterThan(
          previousCleanup,
        );
        previousCleanup = cleanupIndex;
      }
      for (const aliasRelease of aliasReleases) {
        expect(
          clearSource.indexOf(aliasRelease, previousCleanup + 1),
          `${className}: ${aliasRelease}`,
        ).toBeGreaterThan(previousCleanup);
      }
    }
  });

  it("exposes Stage reset without installing a DOM click owner", () => {
    expect(runtimeSource).toContain("export function resetStageView");
    expect(runtimeSource).not.toContain(
      'addEventListener("click", resetDefaultView)',
    );
  });

  it("frames Reset against the renderer that owns the shared Stage", () => {
    const fallback = runtimeSource.slice(
      runtimeSource.indexOf("function getViewFocus"),
      runtimeSource.indexOf("function resetDefaultView"),
    );
    const activeRobots = runtimeSource.slice(
      runtimeSource.indexOf("function activeRobotFocusGroups"),
      runtimeSource.indexOf("/** Frame robot", runtimeSource.indexOf("function activeRobotFocusGroups")),
    );
    const focus = runtimeSource.slice(
      runtimeSource.indexOf("function focusRobotView"),
      runtimeSource.indexOf("/** Orbit distance limits", runtimeSource.indexOf("function focusRobotView")),
    );

    expect(fallback).toContain("h2rOwnsStage");
    expect(fallback).toContain("skin.group.visible && skin.ready");
    for (const group of [
      "r2rSrc.group",
      "r2rTgt.group",
      "r2rSrcSkel.group",
      "r2rTgtSkel.group",
      "r2rSrcEnvGroup",
      "r2rTgtEnvGroup",
    ]) {
      expect(fallback).toContain(`${group}.visible`);
    }
    expect(activeRobots).toContain("if (h2rOwnsStage) return [robot.group]");
    expect(activeRobots).toContain("r2r.calibrating");
    expect(activeRobots).toContain("[r2rSrc.group, r2rTgt.group]");
    expect(focus).toContain("const focusGroups = activeRobotFocusGroups()");
    expect(focus).toContain("refSkel.group.visible");
  });

  it("leaves both Stage layer HUD wrappers to React", () => {
    expect(runtimeSource).not.toContain('getElementById("view-hud")');
    expect(runtimeSource).not.toContain('getElementById("view-hud-r2r")');
  });

  it("leaves Stage empty and Reset presentation to React", () => {
    expect(runtimeSource).not.toMatch(/["'](?:stage-empty|view-reset-btn)["']/);
    expect(runtimeSource).not.toContain("resetVisible");
  });

  it("keeps application Reset commands off the DOM compatibility boundary", () => {
    expect(commandRegistrySource).not.toContain("document.");
    expect(commandRegistrySource).not.toMatch(/["']view-reset-btn["']/);
    expect(commandRegistrySource).toContain("run: context.resetView");
    expect(commandRegistrySource).toContain("enabled: context.canResetView");
  });

  it("lets the React-owned V2M batch dropzone handle its own files", () => {
    const start = runtimeSource.indexOf(
      'setupDropzone(\n  document.getElementById("stage")',
    );
    const end = runtimeSource.indexOf(
      'document.getElementById("add-to-basket")',
      start,
    );
    const stageDropzone = runtimeSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(stageDropzone).toContain('target.closest("#v2m-batch-drop")');
  });

  it("presents generated motion through one ordered aggregate boundary", () => {
    const start = runtimeSource.indexOf(
      "export async function presentHumanMotion",
    );
    const end = runtimeSource.indexOf("function datasetSceneGlbUrl", start);
    const facade = runtimeSource.slice(start, end);
    const load = facade.indexOf("await loadMotionPayload(payload)");
    const refresh = facade.indexOf("await refreshLibrary()");
    const basket = facade.indexOf("addToBasket([payload.library_entry]");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(load).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(load);
    expect(basket).toBeGreaterThan(refresh);
    expect(facade).toContain("{ silent: true }");
  });

  it("exposes H2R display state through a passive local subscription", () => {
    const start = runtimeSource.indexOf(
      "export function subscribeH2rStageDisplayState",
    );
    const end = runtimeSource.indexOf(
      "interface CalibrationEditorUiState",
      start,
    );
    const source = runtimeSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source).toContain("h2rStageDisplayPublisher.subscribe(listener)");
    for (const forbiddenDependency of [
      "start(",
      "window.",
      "document.",
      "addEventListener",
      "dispatchEvent",
      "CustomEvent",
      "import(",
    ]) {
      expect(source).not.toContain(forbiddenDependency);
    }
    expect(runtimeSource).not.toContain("hhtools:h2r-stage-display-state");
  });

  it("publishes primitive visibility setters and batches comparison presets", () => {
    const layerSetter = runtimeSource.slice(
      runtimeSource.indexOf("function setH2rLayerVisible"),
      runtimeSource.indexOf("function setBodyVisible"),
    );
    const bodySetter = runtimeSource.slice(
      runtimeSource.indexOf("function setBodyVisible"),
      runtimeSource.indexOf("function bodyIsRequestedVisible"),
    );
    const preset = runtimeSource.slice(
      runtimeSource.indexOf("function applyH2rComparisonPreset"),
      runtimeSource.indexOf("export function toggleH2rStageLayer"),
    );
    const requested = layerSetter.indexOf("h2rRequestedVisibility[layerId]");
    const projection = layerSetter.indexOf("applyH2rPhysicalVisibility()");
    const refresh = layerSetter.indexOf("player.refreshFrame()");
    const publication = layerSetter.indexOf("markH2rStageDisplayChanged()");

    expect(layerSetter).toContain(
      'state.calibrationMode && layerId !== "targetRobot" && on',
    );
    expect(layerSetter).toContain("markH2rStageDisplayChanged()");
    expect(layerSetter).toContain("h2rRequestedVisibility[layerId]");
    expect(layerSetter).not.toContain(".group.visible =");
    expect(requested).toBeGreaterThanOrEqual(0);
    expect(requested).toBeLessThan(projection);
    expect(projection).toBeLessThan(refresh);
    expect(refresh).toBeLessThan(publication);
    expect(bodySetter).toContain(
      'setH2rLayerVisible("sourceBody", on)',
    );
    expect(preset).toContain("withH2rStageDisplayBatch(() =>");
    expect(preset).not.toContain('"tg-');
  });

  it("keeps all physical H2R group writes inside one projector", () => {
    const projectorStart = runtimeSource.indexOf(
      "function applyH2rPhysicalVisibility",
    );
    const projectorEnd = runtimeSource.indexOf(
      "function emitResultDiagnostics",
      projectorStart,
    );
    const assignments = [...runtimeSource.matchAll(
      /\b(?:skel|mesh|skin|envView|scaledSkel|scaledEnv|robot)\.group\.visible\s*=/g,
    )];

    expect(projectorStart).toBeGreaterThanOrEqual(0);
    expect(projectorEnd).toBeGreaterThan(projectorStart);
    expect(assignments).toHaveLength(7);
    expect(
      assignments.every(
        (match) => match.index >= projectorStart && match.index < projectorEnd,
      ),
    ).toBe(true);
    expect(runtimeSource.slice(projectorStart, projectorEnd)).not.toContain(
      "document.",
    );
  });

  it("snapshots and restores logical H2R visibility through semantic setters", () => {
    const snapshot = runtimeSource.slice(
      runtimeSource.indexOf("function _snapshotVis"),
      runtimeSource.indexOf("function _setPlaybarVisible"),
    );
    const restore = runtimeSource.slice(
      runtimeSource.indexOf("function _restoreVis"),
      runtimeSource.indexOf("async function enterCalibrationMode"),
    );

    expect(snapshot).toContain("h2rRequestedVisibility.sourceSkeleton");
    expect(snapshot).toContain("bodyIsRequestedVisible()");
    expect(snapshot).not.toContain(".group.visible");
    expect(restore).toContain("setH2rLayerVisible(");
    expect(restore).toContain("setBodyVisible(");
    expect(restore).not.toMatch(
      /\b(?:skel|mesh|skin|envView|scaledSkel|scaledEnv|robot)\.group\.visible\s*=/,
    );
  });

  it("executes semantic H2R commands without retaining a DOM owner", () => {
    const lookupPattern =
      /document\.getElementById\("(tg-(?:skeleton|mesh|env|scaled|scaled-env|robot))"\)/g;
    const commandPattern =
      /document\.getElementById\("(tg-(?:skeleton|mesh|env|scaled|scaled-env|robot))"\)\.onclick\s*=/g;
    const literalPattern =
      /"(tg-(?:skeleton|mesh|env|scaled|scaled-env|robot))"/g;
    const start = runtimeSource.indexOf(
      "export function toggleH2rStageLayer",
    );
    const end = runtimeSource.indexOf(
      "function clearH2rScaledPreview",
      start,
    );
    const command = runtimeSource.slice(start, end);

    expect([...runtimeSource.matchAll(lookupPattern)]).toEqual([]);
    expect([...runtimeSource.matchAll(commandPattern)]).toEqual([]);
    expect([...runtimeSource.matchAll(literalPattern)]).toEqual([]);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const identityGuard = command.indexOf(
      "Object.hasOwn(h2rRequestedVisibility, layerId)",
    );
    const currentSnapshot = command.indexOf(
      "collectH2rStageDisplaySnapshot().layers[layerId]",
    );
    const capabilityGuard = command.indexOf("if (!current.canToggle) return");
    const toggle = command.indexOf(
      "setH2rLayerVisible(layerId, !h2rRequestedVisibility[layerId])",
    );

    expect(identityGuard).toBeGreaterThanOrEqual(0);
    expect(identityGuard).toBeLessThan(currentSnapshot);
    expect(currentSnapshot).toBeLessThan(capabilityGuard);
    expect(capabilityGuard).toBeLessThan(toggle);
    for (const forbiddenDependency of [
      "document.",
      "window.",
      "HTMLElement",
      "CustomEvent",
      "dispatchEvent",
    ]) {
      expect(command).not.toContain(forbiddenDependency);
    }
    expect(runtimeSource).not.toContain("hhtools:h2r-stage-layer-command");
    expect(runtimeSource).not.toContain("syncEnvToggleButton");
    expect(runtimeSource).not.toContain("_setCalibViewTogglesDisabled");
    expect(runtimeSource).not.toContain("_restoreViewToggleButtons");
  });

  it("keeps the six R2R layer commands on their explicit legacy boundary", () => {
    const start = runtimeSource.indexOf(
      "const toggleBindings: Array<readonly [string, R2rVisibilityKey]>",
    );
    const end = runtimeSource.indexOf(
      'document.getElementById("r2r-source-load")',
      start,
    );
    const bindings = runtimeSource.slice(start, end);
    const ids = [...bindings.matchAll(/"(r2r-tg-[^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(ids).toEqual([
      "r2r-tg-src-robot",
      "r2r-tg-src-skel",
      "r2r-tg-src-env",
      "r2r-tg-tgt-robot",
      "r2r-tg-tgt-skel",
      "r2r-tg-tgt-env",
    ]);
    expect(bindings).toContain(
      'document.getElementById(id)?.addEventListener("click"',
    );
    expect(bindings).toContain("r2rVis[key] = !r2rVis[key]");
    expect(bindings).toContain("r2rApplyStage()");
  });

  it("reprojects resource-only changes before a display batch is published", () => {
    const batch = runtimeSource.slice(
      runtimeSource.indexOf("function withH2rStageDisplayBatch"),
      runtimeSource.indexOf("export function subscribeH2rStageDisplayState"),
    );
    const operation = batch.indexOf("operation()");
    const cleanup = batch.indexOf("finally");
    const projection = batch.indexOf("applyH2rPhysicalVisibility()", cleanup);

    expect(operation).toBeGreaterThanOrEqual(0);
    expect(operation).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(projection);
  });

  it("publishes R2R surface facts through the passive Stage source", () => {
    const collect = runtimeSource.slice(
      runtimeSource.indexOf("function collectH2rStageDisplaySnapshot"),
      runtimeSource.indexOf("const h2rStageDisplayPublisher"),
    );
    const apply = runtimeSource.slice(
      runtimeSource.indexOf("function r2rApplyStage"),
      runtimeSource.indexOf("/** Apply a repeatable R2R visibility preset"),
    );

    expect(collect).toContain("if (h2rOwnsStage) return h2rSnapshot");
    expect(collect).toContain("collectR2rStageSurface()");
    expect(apply).toContain("collectR2rStageSurfaceFacts()");
    expect(apply).toContain("projectR2rStageSurface(facts)");
    expect(apply).toContain(
      "r2rTgt.group.visible = facts.targetRobotAvailable",
    );
    expect(apply).toContain(
      "refSkel.group.visible = facts.referenceAvailable",
    );
    expect(apply).toContain("if (!surface.empty)");
    expect(apply.match(/markH2rStageDisplayChanged\(\)/g)).toHaveLength(3);
  });

  it("publishes R2R ownership only around a complete H2R handoff", () => {
    const enter = runtimeSource.slice(
      runtimeSource.indexOf("function r2rEnterPanel"),
      runtimeSource.indexOf("function r2rLeavePanel"),
    );
    const leave = runtimeSource.slice(
      runtimeSource.indexOf("function r2rLeavePanel"),
      runtimeSource.indexOf("// Hook panel switching"),
    );
    const normalEnter = enter.slice(enter.indexOf("_r2rMainSnap ="));

    const snapshot = normalEnter.indexOf("_r2rMainSnap =");
    const relinquish = normalEnter.indexOf("h2rOwnsStage = false");
    const hideH2rViews = normalEnter.indexOf("applyH2rPhysicalVisibility()");
    const applyR2r = normalEnter.indexOf("r2rApplyStage()");
    expect(snapshot).toBeLessThan(relinquish);
    expect(relinquish).toBeLessThan(hideH2rViews);
    expect(hideH2rViews).toBeLessThan(applyR2r);
    expect(normalEnter).not.toContain("markH2rStageDisplayChanged()");
    expect(leave).toContain(
      "r2rApplyStage({ publishStageDisplay: false })",
    );
    expect(leave.indexOf("h2rOwnsStage = true")).toBeLessThan(
      leave.indexOf("applyH2rPhysicalVisibility()"),
    );
    expect(leave.indexOf("applyH2rPhysicalVisibility()")).toBeLessThan(
      leave.indexOf("if (player.active) player.refreshFrame()"),
    );
    expect(leave.indexOf("if (player.active) player.refreshFrame()")).toBeLessThan(
      leave.indexOf("markH2rStageDisplayChanged()"),
    );
    expect(
      [...runtimeSource.matchAll(/\bh2rOwnsStage\s*=\s*(true|false)/g)]
        .map((match) => match[1]),
    ).toEqual(["true", "false", "false", "true"]);

    const snapshotContract = runtimeSource.slice(
      runtimeSource.indexOf("interface R2rMainSnapshot"),
      runtimeSource.indexOf("interface R2rRetargetRequest"),
    );
    expect(snapshotContract).not.toContain("vis:");
    expect(snapshotContract).not.toContain("resetVisible");
  });

  it("invalidates scaled previews when their H2R identity changes", () => {
    const referenceChange = runtimeSource.slice(
      runtimeSource.indexOf("async function onReferenceChange"),
      runtimeSource.indexOf("function updatePills"),
    );
    const motionLoad = runtimeSource.slice(
      runtimeSource.indexOf("async function loadMotionPayload"),
      runtimeSource.indexOf("export async function presentHumanMotion"),
    );
    const robotLoad = runtimeSource.slice(
      runtimeSource.indexOf("async function applyRobot"),
      runtimeSource.indexOf("async function loadRobotSummary"),
    );
    const robotDelete = runtimeSource.slice(
      runtimeSource.indexOf("async function deleteRobotSummary"),
      runtimeSource.indexOf("const robotSearchInput"),
    );

    for (const identityCommit of [
      referenceChange,
      motionLoad,
      robotLoad,
      robotDelete,
    ]) {
      expect(identityCommit).toContain("clearH2rScaledPreview()");
    }
  });

  it("commits async retarget results only after the final identity guard", () => {
    const retarget = runtimeSource.slice(
      runtimeSource.indexOf('document.getElementById("retarget-btn").onclick'),
      runtimeSource.indexOf("function csvHeaderEnabled"),
    );
    const finalGuard = retarget.lastIndexOf("if (discardStaleResult()) return");
    const trajectoryCommit = retarget.indexOf(
      "state.robotTrajectory = j.result.trajectory",
    );

    expect(finalGuard).toBeGreaterThanOrEqual(0);
    expect(trajectoryCommit).toBeGreaterThan(finalGuard);
    expect(retarget.slice(finalGuard, trajectoryCommit)).toContain(
      "withH2rStageDisplayBatch(() =>",
    );
  });
});
