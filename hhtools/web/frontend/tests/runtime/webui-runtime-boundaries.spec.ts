import { describe, expect, it } from "vitest";

import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";

describe("legacy runtime ownership boundaries", () => {
  it("exposes Stage reset without installing a DOM click owner", () => {
    expect(runtimeSource).toContain("export function resetStageView");
    expect(runtimeSource).not.toContain(
      'addEventListener("click", resetDefaultView)',
    );
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
    const bodySetter = runtimeSource.slice(
      runtimeSource.indexOf("function setBodyVisible"),
      runtimeSource.indexOf("function bodyIsRequestedVisible"),
    );
    const viewSetter = runtimeSource.slice(
      runtimeSource.indexOf("function setViewVisible"),
      runtimeSource.indexOf("function emitResultDiagnostics"),
    );
    const preset = runtimeSource.slice(
      runtimeSource.indexOf("function applyH2rComparisonPreset"),
      runtimeSource.indexOf('document.getElementById("tg-skeleton")'),
    );

    expect(bodySetter).toContain("markH2rStageDisplayChanged()");
    expect(bodySetter).toContain("h2rRequestedVisibility.sourceBody");
    expect(bodySetter).not.toContain(".group.visible =");
    expect(viewSetter).toContain("markH2rStageDisplayChanged()");
    expect(viewSetter).toContain("h2rRequestedVisibility[layerId]");
    expect(viewSetter).not.toContain(".group.visible =");
    expect(preset).toContain("withH2rStageDisplayBatch(() =>");
  });

  it("keeps all physical H2R group writes inside one projector", () => {
    const projectorStart = runtimeSource.indexOf(
      "function applyH2rPhysicalVisibility",
    );
    const projectorEnd = runtimeSource.indexOf(
      "function setViewVisible",
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
    expect(restore).toContain("setViewVisible(");
    expect(restore).toContain("setBodyVisible(");
    expect(restore).not.toMatch(
      /\b(?:skel|mesh|skin|envView|scaledSkel|scaledEnv|robot)\.group\.visible\s*=/,
    );
  });

  it("preserves comparison toggle locks across projection and R2R return", () => {
    const syncEnvironment = runtimeSource.slice(
      runtimeSource.indexOf("function syncEnvToggleButton"),
      runtimeSource.indexOf("type ViewToggleButtonId"),
    );
    const restoreButtons = runtimeSource.slice(
      runtimeSource.indexOf("function _restoreViewToggleButtons"),
      runtimeSource.indexOf("function updateCalibBanner"),
    );

    expect(syncEnvironment).toContain(
      "btn.disabled = !available || state.calibrationMode",
    );
    expect(restoreButtons).toContain(
      "const comparisonLocked = state.calibrationMode",
    );
    expect(restoreButtons).toContain("skBtn.disabled = comparisonLocked");
    expect(restoreButtons).toContain("meshBtn.disabled = comparisonLocked");
    expect(restoreButtons).toContain(
      "ss.disabled = comparisonLocked || !scaledReady",
    );
    expect(restoreButtons).toContain(
      "se.disabled = comparisonLocked || !scaledReady",
    );
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
    const publishHandoff = normalEnter.indexOf("markH2rStageDisplayChanged()");
    expect(snapshot).toBeLessThan(relinquish);
    expect(relinquish).toBeLessThan(hideH2rViews);
    expect(hideH2rViews).toBeLessThan(applyR2r);
    expect(applyR2r).toBeLessThan(publishHandoff);
    expect(leave.indexOf("_restoreViewToggleButtons()")).toBeLessThan(
      leave.indexOf("h2rOwnsStage = true"),
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
