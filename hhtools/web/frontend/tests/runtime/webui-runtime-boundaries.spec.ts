import { describe, expect, it } from "vitest";

import asyncFrameTaskSource from "../../src/runtime/stage/coalesced-async-frame-task.ts?raw";
import latestAttemptOwnerSource from "../../src/runtime/stage/latest-async-attempt-owner.ts?raw";
import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";
import commandRegistrySource from "../../src/runtime/command-registry.ts?raw";
import robotViewSource from "../../src/runtime/stage/robot-view.ts?raw";

describe("legacy runtime ownership boundaries", () => {
  it("composes the extracted inert Robot Views explicitly", () => {
    expect(runtimeSource).toContain(
      'import { RobotView } from "./stage/robot-view"',
    );
    expect(runtimeSource).not.toContain("class RobotView");
    expect(robotViewSource).toContain("export class RobotView");
    expect(robotViewSource).not.toContain("world.add(");
    expect(runtimeSource.match(/world\.add\((?:robot|r2rSrc|r2rTgt)\.group\)/g))
      .toHaveLength(3);
  });

  it("routes both calibration FK loops through terminal session owners", () => {
    expect(runtimeSource).toContain(
      'import { CoalescedAsyncFrameTask } from "./stage/coalesced-async-frame-task"',
    );
    for (const legacyAlias of [
      "calibFkRaf",
      "calibFkInFlight",
      "calibFkQueued",
      "_runCalibFk",
      "_r2rFkRaf",
      "_r2rFkInFlight",
      "_r2rFkQueued",
      "_r2rRunFk",
    ]) {
      expect(runtimeSource).not.toContain(legacyAlias);
    }

    const h2rEntry = runtimeSource.slice(
      runtimeSource.indexOf("async function enterCalibrationMode"),
      runtimeSource.indexOf("function updateCalibRestoreButton"),
    );
    expect(h2rEntry.indexOf("h2rCalibrationFkPreview.start()"))
      .toBeLessThan(h2rEntry.indexOf("state.calibrationMode = true"));

    const h2rPreview = runtimeSource.slice(
      runtimeSource.indexOf("interface H2rCalibrationFkResult"),
      runtimeSource.indexOf("async function refreshRetargetPanel"),
    );
    expect(h2rPreview).toContain("new CoalescedAsyncFrameTask<");
    expect(h2rPreview).toContain("h2rCalibrationFkPreview.flush()");
    expect(h2rPreview).toContain("h2rCalibrationFkPreview.schedule()");
    expect(h2rPreview).toContain("state.robot !== result.activeRobot");
    expect(h2rPreview).toContain("state.motion !== result.activeMotion");
    expect(h2rPreview).toContain("state.reference !== result.reference");

    const h2rExit = runtimeSource.slice(
      runtimeSource.indexOf("function exitCalibrationMode"),
      runtimeSource.indexOf("function setCalibJointValue"),
    );
    expect(h2rExit.indexOf("h2rCalibrationFkPreview.stop()"))
      .toBeLessThan(h2rExit.indexOf("state.calibrationMode = false"));
    const h2rLoss = runtimeSource.slice(
      runtimeSource.indexOf("function clearH2rRobotAfterViewLoss"),
      runtimeSource.indexOf("async function refreshScaledPreview"),
    );
    expect(h2rLoss.indexOf("h2rCalibrationFkPreview.stop()"))
      .toBeLessThan(h2rLoss.indexOf("state.robot = null"));

    const r2rPreview = runtimeSource.slice(
      runtimeSource.indexOf("interface R2rCalibrationFkResult"),
      runtimeSource.indexOf("function r2rSetCalibJointValue"),
    );
    expect(r2rPreview).toContain("new CoalescedAsyncFrameTask<");
    expect(r2rPreview).toContain("r2rCalibrationFkPreview.flush()");
    expect(r2rPreview).toContain("r2rCalibrationFkPreview.schedule()");
    expect(r2rPreview).toContain("r2r.sourceName !== result.sourceName");
    expect(r2rPreview).toContain("r2r.sourcePayload !== result.sourcePayload");
    expect(r2rPreview).toContain("r2r.targetName !== result.targetName");
    expect(r2rPreview).toContain("r2r.targetPayload !== result.targetPayload");

    const r2rEntry = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rStartCalib"),
      runtimeSource.indexOf("function r2rExitCalib"),
    );
    expect(r2rEntry.indexOf("r2rCalibrationFkPreview.start()"))
      .toBeLessThan(r2rEntry.indexOf("r2r.calibrating = true"));
    const r2rExit = runtimeSource.slice(
      runtimeSource.indexOf("function r2rExitCalib"),
      runtimeSource.indexOf("async function r2rMaybeAutoCalib"),
    );
    expect(r2rExit.indexOf("r2rCalibrationFkPreview.stop()"))
      .toBeLessThan(r2rExit.indexOf("r2r.calibrating = false"));
    const r2rLoss = runtimeSource.slice(
      runtimeSource.indexOf("function clearR2rCalibrationAfterViewLoss"),
      runtimeSource.indexOf("function clearR2rDerivedTargetAfterViewLoss"),
    );
    expect(r2rLoss.indexOf("r2rCalibrationFkPreview.stop()"))
      .toBeLessThan(r2rLoss.indexOf("r2r.calibrating = false"));

    expect(asyncFrameTaskSource).not.toMatch(/\b(?:document|window)\b/);
    expect(asyncFrameTaskSource).toContain("this.#session = null");
    expect(asyncFrameTaskSource).toContain("if (!this.#isCurrent(session)) return");
  });

  it("guards H2R calibration bootstrap and status publication by attempt identity", () => {
    expect(runtimeSource).toContain(
      'from "./stage/latest-async-attempt-owner"',
    );
    expect(latestAttemptOwnerSource).not.toMatch(/\b(?:document|window)\b/);
    expect(latestAttemptOwnerSource).toContain("export class LatestAsyncAttemptOwner");

    const bootstrapDefinitions = runtimeSource.slice(
      runtimeSource.indexOf("interface H2rCalibrationPairIdentity"),
      runtimeSource.indexOf("async function enterCalibrationMode"),
    );
    for (const identityCheck of [
      "state.robot === identity.robot",
      "state.robot?.name === identity.robotName",
      "robot.isLoadGenerationCurrent(identity.robotViewGeneration)",
      "state.motion === identity.motion",
      "(state.motion?.token ?? null) === identity.motionToken",
      "state.reference === identity.reference",
    ]) {
      expect(bootstrapDefinitions).toContain(identityCheck);
    }

    const entry = runtimeSource.slice(
      runtimeSource.indexOf("async function enterCalibrationMode"),
      runtimeSource.indexOf("function updateCalibRestoreButton"),
    );
    const beginAttempt = entry.indexOf("h2rCalibrationBootstrapAttempts.begin({");
    const firstSessionMutation = entry.indexOf("state.calibRestore = _snapshotVis()");
    const request = entry.indexOf('await API.post("/api/calibration/session"');
    const awaitGuard = entry.indexOf('if (!isCurrent()) return "stale"', request);
    const referenceValidation = entry.indexOf("if (!session.reference)", awaitGuard);
    const firstResponseMutation = entry.indexOf("state.calibLimits =", referenceValidation);
    expect(beginAttempt).toBeGreaterThanOrEqual(0);
    expect(firstSessionMutation).toBeGreaterThan(beginAttempt);
    expect(request).toBeGreaterThan(firstSessionMutation);
    expect(awaitGuard).toBeGreaterThan(request);
    expect(referenceValidation).toBeGreaterThan(awaitGuard);
    expect(firstResponseMutation).toBeGreaterThan(referenceValidation);
    expect(entry).toContain("robot: attempt.identity.robotName");
    expect(entry).toContain("reference: attempt.identity.reference");
    expect(entry).toContain("motion_token: attempt.identity.motionToken");
    expect(entry).toContain("robotGroundOffset: robot.groundOffset");
    expect(entry).not.toContain("robot: state.robot.name");
    expect(entry).not.toContain("motion_token: state.motion?.token");
    expect(entry.match(/state\.calibOrbitSaved = \{/g)).toHaveLength(1);
    expect(entry).toContain("if (enteringFresh) {");
    const catchStart = entry.lastIndexOf("} catch (error) {");
    const staleCatchGuard = entry.indexOf('if (!isCurrent()) return "stale"', catchStart);
    const rollbackCall = entry.indexOf("rollbackH2rCalibrationBootstrap(attempt, error)", catchStart);
    expect(staleCatchGuard).toBeGreaterThan(catchStart);
    expect(rollbackCall).toBeGreaterThan(staleCatchGuard);

    const rollback = runtimeSource.slice(
      runtimeSource.indexOf("function rollbackH2rCalibrationBootstrap"),
      runtimeSource.indexOf("async function enterCalibrationMode"),
    );
    expect(rollback).toContain("): boolean {");
    expect(rollback.indexOf("h2rCalibrationBootstrapAttempts.isCurrent(attempt)"))
      .toBeLessThan(rollback.indexOf("h2rCalibrationFkPreview.stop()"));
    expect(rollback).toContain("state.calibrationMode = false");
    expect(rollback).toContain("calibManip.stop()");
    expect(rollback).toContain("_restoreVis(visibilitySnapshot)");
    expect(rollback).toContain("robot.groundOffset = attempt.identity.robotGroundOffset");
    expect(rollback).toContain("toast(errorMessage(error), true)");
    const rollbackFinish = rollback.indexOf(
      "h2rCalibrationBootstrapAttempts.finish(attempt)",
    );
    expect(rollbackFinish).toBeGreaterThanOrEqual(0);
    expect(rollback.indexOf("state.calibOrbitSaved = null"))
      .toBeGreaterThan(rollbackFinish);
    expect(rollback.indexOf("state.calibRestore = null"))
      .toBeGreaterThan(rollbackFinish);
    expect(entry).toContain("rollbackH2rCalibrationBootstrap(attempt, error)");
    expect(entry).toContain('? "failed"');
    expect(entry).toContain(': "stale"');

    const exit = runtimeSource.slice(
      runtimeSource.indexOf("function exitCalibrationMode"),
      runtimeSource.indexOf("function setCalibJointValue"),
    );
    expect(exit.indexOf("h2rCalibrationBootstrapAttempts.invalidate()"))
      .toBeLessThan(exit.indexOf("h2rCalibrationFkPreview.stop()"));
    expect(exit.indexOf("h2rCalibrationStatusAttempts.invalidate()"))
      .toBeLessThan(exit.indexOf("state.calibrationMode = false"));
    const viewLoss = runtimeSource.slice(
      runtimeSource.indexOf("function clearH2rRobotAfterViewLoss"),
      runtimeSource.indexOf("async function refreshScaledPreview"),
    );
    expect(viewLoss.indexOf("h2rCalibrationBootstrapAttempts.invalidate()"))
      .toBeLessThan(viewLoss.indexOf("state.robot = null"));
    expect(viewLoss.indexOf("h2rCalibrationStatusAttempts.invalidate()"))
      .toBeLessThan(viewLoss.indexOf("state.robot = null"));

    const motionLoad = runtimeSource.slice(
      runtimeSource.indexOf("async function loadMotionPayload"),
      runtimeSource.indexOf("export async function presentHumanMotion"),
    );
    expect(motionLoad).toContain("const wasCalibrating = state.calibrationMode");
    expect(motionLoad).toContain("await enterCalibrationMode(calibrationDraft)");
    expect(motionLoad).toContain("calibrationMotionLoadDisposition(");
    expect(motionLoad).toContain("state.calibrationMode,");
    expect(motionLoad).toContain('if (disposition === "stale") return "stale"');
    expect(motionLoad).toContain('if (disposition === "calibration")');
    expect(motionLoad).toContain("(state.motion?.token ?? null) === calibrationMotionToken");
    expect(motionLoad).toContain('state.motion?.token !== payload.token) return "stale"');
    expect(motionLoad).toContain("exitCalibrationMode()");

    const statusRefreshStart = runtimeSource.indexOf("async function refreshRetargetPanel");
    const statusRefresh = runtimeSource.slice(
      statusRefreshStart,
      runtimeSource.indexOf(
        'document.getElementById("rt-ref-select")',
        statusRefreshStart,
      ),
    );
    const statusAwait = statusRefresh.indexOf("calibrationStatus = await API.get(");
    const statusGuard = statusRefresh.indexOf("if (!statusIsCurrent()) return", statusAwait);
    const statusCommit = statusRefresh.indexOf("state.calibration =", statusGuard);
    expect(statusAwait).toBeGreaterThanOrEqual(0);
    expect(statusGuard).toBeGreaterThan(statusAwait);
    expect(statusCommit).toBeGreaterThan(statusGuard);
    expect(statusRefresh).toContain("h2rCalibrationStatusAttempts.begin({");
    expect(statusRefresh).toContain("motion: state.motion");
    expect(statusRefresh).toContain("motionToken: state.motion?.token ?? null");

    const recalibrate = runtimeSource.slice(
      runtimeSource.indexOf('document.getElementById("recalib-btn").onclick'),
      runtimeSource.indexOf('document.getElementById("calib-zero").onclick'),
    );
    const recalibrateAwait = recalibrate.indexOf("const st = await API.get(");
    const recalibrateGuard = recalibrate.indexOf(
      "h2rCalibrationStatusAttempts.isCurrent(statusAttempt)",
      recalibrateAwait,
    );
    const recalibrateEntry = recalibrate.indexOf("await enterCalibrationMode(jq)");
    expect(recalibrateGuard).toBeGreaterThan(recalibrateAwait);
    expect(recalibrateEntry).toBeGreaterThan(recalibrateGuard);
    expect(recalibrate).toContain("motion: activeMotion");
    expect(recalibrate).toContain("motionToken: activeMotion?.token ?? null");

    expect(runtimeSource).toContain("function buildCalibSliders(");
    expect(runtimeSource).not.toContain("async function buildCalibSliders(");
    expect(runtimeSource).not.toContain("await buildCalibSliders(");
    expect(runtimeSource).toContain("function exitCalibrationMode(): void");
    expect(runtimeSource).not.toContain("await exitCalibrationMode()");
  });

  it("terminalizes R2R calibration status and bootstrap under one pair identity", () => {
    const definitions = runtimeSource.slice(
      runtimeSource.indexOf("interface R2rCalibrationIdentity"),
      runtimeSource.indexOf("function calibrationRows"),
    );
    for (const identityCheck of [
      "r2r.sourceName === identity.sourceName",
      "r2r.sourcePayload === identity.sourcePayload",
      "r2r.sourceToken === identity.sourceToken",
      "r2rSrc.isLoadGenerationCurrent(identity.sourceViewGeneration)",
      "r2r.targetName === identity.targetName",
      "r2r.targetPayload === identity.targetPayload",
      "r2r.targetPayload === identity.resolvedTargetPayload",
      "r2rTgt.isLoadGenerationCurrent(identity.targetViewGeneration)",
    ]) {
      expect(definitions).toContain(identityCheck);
    }
    expect(definitions).toContain("sourceViewGeneration: r2rSrc.loadGeneration");
    expect(definitions).toContain("targetViewGeneration: r2rTgt.loadGeneration");
    expect(definitions).toContain("let r2rCalibrationResourcesOwned = false");
    expect(definitions).toContain("let r2rCalibrationRestoreGroundOffset: number | null = null");
    expect(definitions).toContain("let r2rCalibrationPendingAttempt:");
    expect(definitions).toContain("function beginR2rCalibrationBootstrapAttempt(");
    expect(definitions).toContain("r2rCalibrationPendingAttempt = attempt");
    expect(definitions).toContain("function finishR2rCalibrationBootstrapAttempt(");
    expect(definitions).toContain("if (r2rCalibrationPendingAttempt === attempt)");
    expect(definitions).toContain("function r2rCalibrationBootstrapIsPending()");
    expect(definitions).toContain("r2rCalibrationBootstrapAttempts.isCurrent(attempt)");

    const status = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rUpdateRetargetBtn"),
      runtimeSource.indexOf("// --------------------------------------------------------------- robot pickers"),
    );
    const statusRequest = status.indexOf("const st = await API.get(");
    const statusGuard = status.indexOf("if (!statusIsCurrent())", statusRequest);
    const statusCommit = status.indexOf("r2r.calibrated = calibrated", statusGuard);
    expect(statusRequest).toBeGreaterThanOrEqual(0);
    expect(statusGuard).toBeGreaterThan(statusRequest);
    expect(statusCommit).toBeGreaterThan(statusGuard);
    expect(status).toContain("!r2r.calibrating");
    const producerPendingGate = status.indexOf(
      "r2r.calibrating || r2rCalibrationBootstrapIsPending()",
    );
    expect(producerPendingGate).toBeGreaterThanOrEqual(0);
    expect(producerPendingGate).toBeLessThan(statusRequest);
    expect(status).toContain("&& !r2rCalibrationBootstrapIsPending()");
    expect(status).toContain("identity.targetName");
    expect(status).toContain("identity.sourceName");
    expect(status).toContain("receipt: { attempt: statusAttempt, calibrated }");
    // The caller consumes this still-live receipt; finishing here would reopen
    // a microtask gap where an exit or replacement could auto-start old state.
    expect(status).not.toContain("finish(statusAttempt)");
    for (const effect of [
      "r2rSetCalChip(",
      "r2rRenderBasket()",
      "publishR2rWorkflowState()",
    ]) {
      const effectAt = status.indexOf(effect, statusCommit);
      const guardAt = status.indexOf("if (!statusIsCurrent())", effectAt);
      expect(effectAt, `status effect: ${effect}`).toBeGreaterThanOrEqual(0);
      expect(guardAt, `status guard: ${effect}`).toBeGreaterThan(effectAt);
    }

    const ensure = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rEnsureCalibration"),
      runtimeSource.indexOf("async function r2rMaybeAutoCalib"),
    );
    const statusAwait = ensure.indexOf("await r2rUpdateRetargetBtn()");
    const activeConsumerGuard = ensure.indexOf(
      'if (r2r.calibrating || r2rCalibrationBootstrapIsPending()) return "entered"',
      statusAwait,
    );
    const receiptCheck = ensure.indexOf(
      "r2rCalibrationStatusAttempts.isCurrent(receipt.attempt)",
      statusAwait,
    );
    const bootstrapHandoff = ensure.indexOf("return r2rStartCalib({ auto })", receiptCheck);
    expect(statusAwait).toBeGreaterThanOrEqual(0);
    expect(activeConsumerGuard).toBeGreaterThan(statusAwait);
    expect(receiptCheck).toBeGreaterThan(activeConsumerGuard);
    expect(bootstrapHandoff).toBeGreaterThan(receiptCheck);

    const entry = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rStartCalib"),
      runtimeSource.indexOf("function r2rExitCalib"),
    );
    const missingPair = entry.slice(
      entry.indexOf("if (!capturedIdentity)"),
      entry.indexOf("let attempt ="),
    );
    expect(missingPair).not.toContain("r2rCalibrationBootstrapAttempts.invalidate()");
    expect(missingPair).not.toContain("invalidateR2rCalibrationBootstrapAttempt()");
    const firstBegin = entry.indexOf(
      "beginR2rCalibrationBootstrapAttempt(capturedIdentity)",
    );
    const sessionAwait = entry.indexOf(
      'await API.post("/api/r2r/calibration/session"',
      firstBegin,
    );
    const sessionGuard = entry.indexOf(
      'if (!isCurrent()) return "stale"',
      sessionAwait,
    );
    const selectAwait = entry.indexOf(
      'targetPayload = await API.post("/api/robot/select"',
      sessionGuard,
    );
    const selectGuard = entry.indexOf(
      'if (!isCurrent()) return "stale"',
      selectAwait,
    );
    expect(firstBegin).toBeGreaterThanOrEqual(0);
    expect(sessionAwait).toBeGreaterThan(firstBegin);
    expect(sessionGuard).toBeGreaterThan(sessionAwait);
    expect(selectAwait).toBeGreaterThan(sessionGuard);
    expect(selectGuard).toBeGreaterThan(selectAwait);
    expect(entry).toContain("target: attempt.identity.targetName");
    expect(entry).toContain("source: attempt.identity.sourceName");

    const wildcardBegin = entry.indexOf("targetViewGeneration: null", selectGuard);
    const targetLoadStart = entry.indexOf(
      "const targetLoadAttempt = startRobotViewLoad(r2rTgt, targetPayload)",
      wildcardBegin,
    );
    const actualGeneration = entry.indexOf(
      "targetLoadGeneration = targetLoadAttempt.generation",
      targetLoadStart,
    );
    const postStartGuard = entry.indexOf(
      'if (!isCurrent()) return "stale"',
      actualGeneration,
    );
    const exactBegin = entry.indexOf(
      "targetViewGeneration: targetLoadGeneration",
      postStartGuard,
    );
    const targetLoadAwait = entry.indexOf(
      "await targetLoadAttempt.completion",
      exactBegin,
    );
    expect(wildcardBegin).toBeGreaterThan(selectGuard);
    expect(targetLoadStart).toBeGreaterThan(wildcardBegin);
    expect(actualGeneration).toBeGreaterThan(targetLoadStart);
    expect(postStartGuard).toBeGreaterThan(actualGeneration);
    expect(exactBegin).toBeGreaterThan(postStartGuard);
    expect(targetLoadAwait).toBeGreaterThan(exactBegin);
    expect(entry.slice(wildcardBegin, exactBegin)).not.toContain("await ");
    const targetLoadCatch = entry.indexOf("} catch (error) {", targetLoadAwait);
    const targetLossRollback = entry.indexOf("{ targetViewLost: true }", targetLoadCatch);
    expect(targetLossRollback).toBeGreaterThan(targetLoadCatch);
    expect(entry).not.toContain("clearR2rTargetAfterViewLoss(");
    expect(entry).toContain("let calibrationResourcesOwned = r2rCalibrationResourcesOwned");
    expect(entry).toContain("r2rCalibrationRestoreGroundOffset ?? r2rTgt.groundOffset");
    expect(entry).toContain("r2rCalibrationResourcesOwned = true");
    const activeTransition = entry.indexOf("r2r.calibrating = true");
    const transitionStatusInvalidation = entry.lastIndexOf(
      "r2rCalibrationStatusAttempts.invalidate()",
      activeTransition,
    );
    expect(transitionStatusInvalidation).toBeGreaterThan(
      entry.indexOf("const enteringFresh"),
    );
    expect(transitionStatusInvalidation).toBeLessThan(activeTransition);

    const guardedEffects = [
      "r2rCalibrationFkPreview.stop()",
      'switchInspectorPanel("r2r")',
      "r2rEnterPanel()",
      "r2rCalibrationFkPreview.start()",
      "applyCalibOrbitLimits()",
      "updateR2rCalibBanner()",
      'classList.remove("hidden")',
      "r2rSetCalChip(",
      "publishR2rWorkflowState()",
      "refSkel.load(reference)",
      "refSkel.configureMappings(",
      'editor.style.display = "block"',
      "r2rApplyStage()",
      "calibManip.start(",
      "applyCalibrationVisualization(",
      "editor.scrollIntoView(",
      "r2rFocus(r2rTgt)",
      "toast(auto",
    ];
    for (const effect of guardedEffects) {
      const effectAt = entry.indexOf(effect);
      const guardAt = entry.indexOf('if (!isCurrent()) return "stale"', effectAt);
      expect(effectAt, `bootstrap effect: ${effect}`).toBeGreaterThanOrEqual(0);
      expect(guardAt, `bootstrap guard: ${effect}`).toBeGreaterThan(effectAt);
    }
    expect(entry).toContain(
      "if (!r2rBuildSliders(initialQ, r2r.calibLimits, isCurrent)) return \"stale\"",
    );

    const sliders = runtimeSource.slice(
      runtimeSource.indexOf("function r2rBuildSliders"),
      runtimeSource.indexOf("function rollbackR2rCalibrationBootstrap"),
    );
    expect(sliders).toContain("isCurrent: () => boolean");
    expect(sliders).toContain("box.replaceChildren()");
    expect(sliders.match(/if \(!isCurrent\(\)\) return false/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(6);
    expect(sliders.indexOf("if (!isCurrent()) return false", sliders.indexOf("calibManip.updateHudValue")))
      .toBeGreaterThan(sliders.indexOf("calibManip.updateHudValue"));

    const rollback = runtimeSource.slice(
      runtimeSource.indexOf("function rollbackR2rCalibrationBootstrap"),
      runtimeSource.indexOf("async function r2rStartCalib"),
    );
    const withdrawal = rollback.slice(
      rollback.indexOf("if (targetViewLost)"),
      rollback.indexOf("// Canonical editor aliases"),
    );
    expect(withdrawal.indexOf("beginR2rCalibrationBootstrapAttempt({"))
      .toBeLessThan(withdrawal.indexOf("r2r.targetName = null"));
    expect(withdrawal).toContain("targetCapabilityWithdrawn: true");
    expect(rollback).toContain(
      "r2r.calibrated = targetViewLost ? false : attempt.identity.calibratedBefore",
    );
    expect(rollback).toContain("if (!r2rCalibrationBootstrapAttempts.isCurrent(attempt)) return false");
    expect(rollback).toContain("runBestEffortCleanup(context, action)");
    const rollbackFinish = rollback.indexOf(
      "finishR2rCalibrationBootstrapAttempt(attempt)",
    );
    expect(rollbackFinish).toBeGreaterThan(rollback.indexOf("toast(errorMessage(error), true)"));
    expect(rollback.indexOf("r2r.calibOrbitSaved = null")).toBeGreaterThan(rollbackFinish);
    expect(rollback.indexOf("r2rCalibrationResourcesOwned = false")).toBeGreaterThan(rollbackFinish);
    expect(rollback.indexOf("r2rCalibrationRestoreGroundOffset = null")).toBeGreaterThan(rollbackFinish);
    expect(rollback).not.toContain("clearR2rTargetAfterViewLoss(");
    expect(rollback).not.toContain("setR2rRobotStatus(");
    for (const guardedCleanup of [
      "reference visibility cleanup failed",
      "result diagnostics cleanup failed",
      "export card cleanup failed",
      "target status cleanup failed",
      "target toggle cleanup failed",
      "editor publication failed",
    ]) {
      expect(rollback).toContain(guardedCleanup);
    }

    const exit = runtimeSource.slice(
      runtimeSource.indexOf("function r2rExitCalib"),
      runtimeSource.indexOf("type R2rEnsureCalibrationResult"),
    );
    expect(exit.indexOf("invalidateR2rCalibrationAttempts()"))
      .toBeLessThan(exit.indexOf("r2rCalibrationFkPreview.stop()"));
    expect(exit.indexOf("r2rCalibrationFkPreview.stop()"))
      .toBeLessThan(exit.indexOf("r2r.calibrating = false"));
    const leave = runtimeSource.slice(
      runtimeSource.indexOf("function r2rLeavePanel"),
      runtimeSource.indexOf("function r2rSetCalChip"),
    );
    expect(leave.indexOf("invalidateR2rCalibrationAttempts()"))
      .toBeLessThan(leave.indexOf("r2r.active = false"));
    expect(leave).toContain("|| r2rCalibrationResourcesOwned");
    expect(leave).toContain("|| r2r.calibOrbitSaved !== null");
    expect(leave.indexOf("r2r.active = false"))
      .toBeLessThan(leave.indexOf("r2rExitCalib({ publishStageDisplay: false })"));
    const replacement = runtimeSource.slice(
      runtimeSource.indexOf("function prepareR2rRobotReplacement"),
      runtimeSource.indexOf("function clearR2rCalibrationAfterViewLoss"),
    );
    expect(replacement.indexOf("invalidateR2rCalibrationAttempts()"))
      .toBeLessThan(replacement.indexOf("r2rExitCalib()"));
    expect(replacement).toContain("r2rCalibrationResourcesOwned");
    for (const functionName of [
      "clearR2rCalibrationAfterViewLoss",
      "clearR2rSourceAfterViewLoss",
      "clearR2rTargetAfterViewLoss",
    ]) {
      const start = runtimeSource.indexOf(`function ${functionName}`);
      const body = runtimeSource.slice(start, runtimeSource.indexOf("\n}", start) + 2);
      expect(body).toContain("invalidateR2rCalibrationAttempts()");
    }

    const replacementLoads = [
      {
        name: "selected source",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rLoadSourceRobot"),
          runtimeSource.indexOf("async function r2rLoadTargetRobot"),
        ),
        start: "const attempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        commit: "r2r.sourcePayload = sourcePayload",
      },
      {
        name: "automatic source",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rEnsureSourceLoaded"),
          runtimeSource.indexOf("async function r2rUploadTraj"),
        ),
        start: "const attempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        commit: "r2r.sourcePayload = sourcePayload",
      },
      {
        name: "trajectory source",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rApplySourceTrajectoryResult"),
          runtimeSource.indexOf("async function loadR2rLibraryEntry"),
        ),
        start: "const attempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        commit: "r2r.sourceToken = data.token",
      },
      {
        name: "retarget target",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rRunRetarget"),
          runtimeSource.indexOf("// --------------------------------------------------------------- batch"),
        ),
        start: "const attempt = startRobotViewLoad(r2rTgt, targetPayload)",
        commit: "r2r.targetPayload = targetPayload",
      },
    ] as const;
    for (const load of replacementLoads) {
      const start = load.source.indexOf(load.start);
      const before = load.source.lastIndexOf("prepareR2rRobotReplacement()", start);
      const commit = load.source.indexOf(load.commit, start);
      const after = load.source.lastIndexOf("prepareR2rRobotReplacement()", commit);
      expect(before, `${load.name}: pre-load invalidation`).toBeGreaterThanOrEqual(0);
      expect(start, `${load.name}: view load`).toBeGreaterThan(before);
      expect(after, `${load.name}: post-load invalidation`).toBeGreaterThan(start);
      expect(commit, `${load.name}: commit`).toBeGreaterThan(after);
    }
  });

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
        endMarker: "class ReferenceSkeletonView",
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
        endMarker: "class EnvView",
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
        endMarker: "class ScaledSkeletonView",
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
        endMarker: "// Scaled-environment interpolation",
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
      endMarker,
      inventory,
      cleanup,
      aliasReleases,
    } of synchronousViews) {
      const classStart = runtimeSource.indexOf(`class ${className}`);
      const classEnd = runtimeSource.indexOf(endMarker, classStart);
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
    const staleGuard = facade.indexOf(
      'if (loadResult === "stale") return "superseded"',
    );
    const refresh = facade.indexOf("await refreshLibrary()");
    const basket = facade.indexOf("addToBasket([payload.library_entry]");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(load).toBeGreaterThanOrEqual(0);
    expect(staleGuard).toBeGreaterThan(load);
    expect(refresh).toBeGreaterThan(staleGuard);
    expect(basket).toBeGreaterThan(refresh);
    expect(facade).toContain("{ silent: true }");
    expect(facade).toContain('return "presented"');
  });

  it("stops every motion-load caller after a stale baked-mesh generation", () => {
    const motionLoad = runtimeSource.slice(
      runtimeSource.indexOf("async function loadMotionPayload"),
      runtimeSource.indexOf("export async function presentHumanMotion"),
    );
    const bakedLoad = motionLoad.indexOf(
      "const skinLoadResult = await skin.load(payload.body_mesh)",
    );
    const bakedGuard = motionLoad.indexOf(
      'if (skinLoadResult === "stale") return "stale"',
      bakedLoad,
    );
    const backendPublication = motionLoad.indexOf("payload.suggested_backend");
    const calibrationStart = motionLoad.indexOf(
      "if (wasCalibrating)",
    );
    const calibrationSkinClear = motionLoad.indexOf(
      "skin.clear()",
      calibrationStart,
    );
    const calibrationReturn = motionLoad.indexOf(
      'return "committed"',
      calibrationSkinClear,
    );
    expect(calibrationStart).toBeGreaterThanOrEqual(0);
    expect(calibrationSkinClear).toBeGreaterThan(calibrationStart);
    expect(calibrationReturn).toBeGreaterThan(calibrationSkinClear);
    expect(calibrationReturn).toBeLessThan(bakedLoad);
    expect(bakedLoad).toBeGreaterThanOrEqual(0);
    expect(bakedGuard).toBeGreaterThan(bakedLoad);
    expect(backendPublication).toBeGreaterThan(bakedGuard);

    const libraryLoad = runtimeSource.slice(
      runtimeSource.indexOf("async function loadLibraryEntryRequest"),
      runtimeSource.indexOf("async function loadLibraryEntry(",
        runtimeSource.indexOf("async function loadLibraryEntryRequest")),
    );
    expect(libraryLoad).toContain(
      'if (loadResult === "stale") return "stale"',
    );

    const ingest = runtimeSource.slice(
      runtimeSource.indexOf("async function ingestMotionFiles"),
      runtimeSource.indexOf("function initMotionImportZone"),
    );
    const ingestGuard = ingest.indexOf(
      'if (loadResult === "stale") return null',
    );
    expect(ingestGuard).toBeGreaterThanOrEqual(0);
    expect(ingest.indexOf("await refreshLibrary()", ingestGuard)).toBeGreaterThan(
      ingestGuard,
    );
    expect(ingest.indexOf("addToBasket(", ingestGuard)).toBeGreaterThan(
      ingestGuard,
    );
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
    ]) {
      expect(identityCommit).toContain("clearH2rScaledPreview()");
    }
    expect(robotDelete).toContain(
      'clearH2rRobotAfterViewLoss("deleted robot")',
    );
    const robotLossCleanup = runtimeSource.slice(
      runtimeSource.indexOf("function clearH2rRobotAfterViewLoss"),
      runtimeSource.indexOf("async function refreshScaledPreview"),
    );
    expect(robotLossCleanup).toContain("scaledSkel.clear()");
    expect(robotLossCleanup).toContain("scaledEnv.clear()");
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

  it("does not publish RobotView caller state after a stale load", () => {
    const callerSlices = [
      {
        name: "H2R export preview",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function loadRobotExportPreview"),
          runtimeSource.indexOf("async function previewRobotClip"),
        ),
        start: "const attempt = startRobotViewLoad(robot, robotData)",
        load: "const loadResult = await attempt.completion",
        staleCheck: 'loadResult === "stale"',
        generationCheck:
          "!robot.isLoadGenerationCurrent(attempt.generation)",
        commit: "state.robot = selectedRobot",
      },
      {
        name: "H2R robot selection",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function applyRobot"),
          runtimeSource.indexOf("async function refreshRobotList"),
        ),
        start: "const attempt = startRobotViewLoad(robot, robotData)",
        load: "const loadResult = await attempt.completion",
        staleCheck: 'loadResult === "stale"',
        generationCheck:
          "!robot.isLoadGenerationCurrent(attempt.generation)",
        commit: "state.robot = robotData",
      },
      {
        name: "R2R source selection",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rLoadSourceRobot"),
          runtimeSource.indexOf("async function r2rLoadTargetRobot"),
        ),
        start: "const attempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        load: "loadResult = await attempt.completion",
        staleCheck: 'loadResult === "stale"',
        generationCheck:
          "!r2rSrc.isLoadGenerationCurrent(attempt.generation)",
        commit: "r2r.sourcePayload = sourcePayload",
      },
      {
        name: "R2R calibration target",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rStartCalib"),
          runtimeSource.indexOf("function r2rExitCalib"),
        ),
        start: "const targetLoadAttempt = startRobotViewLoad(r2rTgt, targetPayload)",
        load: "targetLoadResult = await targetLoadAttempt.completion",
        staleCheck: 'targetLoadResult === "stale"',
        generationCheck: "!isCurrent()",
        commit: "r2rTgt.groundOffset =",
      },
      {
        name: "R2R automatic source",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rEnsureSourceLoaded"),
          runtimeSource.indexOf("async function r2rUploadTraj"),
        ),
        start: "const attempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        load: "loadResult = await attempt.completion",
        staleCheck: 'loadResult === "stale"',
        generationCheck:
          "!r2rSrc.isLoadGenerationCurrent(attempt.generation)",
        commit: "r2r.sourcePayload = sourcePayload",
      },
      {
        name: "R2R source trajectory",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rApplySourceTrajectoryResult"),
          runtimeSource.indexOf("async function loadR2rLibraryEntry"),
        ),
        start: "const attempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        load: "loadResult = await attempt.completion",
        staleCheck: 'loadResult === "stale"',
        generationCheck:
          "!r2rSrc.isLoadGenerationCurrent(attempt.generation)",
        commit: "r2rSrc.setTrajectory(data.trajectory)",
      },
      {
        name: "R2R retarget result",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rRunRetarget"),
          runtimeSource.indexOf("// --------------------------------------------------------------- batch"),
        ),
        start: "const attempt = startRobotViewLoad(r2rTgt, targetPayload)",
        load: "targetLoadResult = await attempt.completion",
        staleCheck: 'targetLoadResult === "stale"',
        generationCheck:
          "!r2rTgt.isLoadGenerationCurrent(attempt.generation)",
        commit: "r2rTgt.setTrajectory(j.result.trajectory)",
      },
    ] as const;

    for (const caller of callerSlices) {
      const start = caller.source.indexOf(caller.start);
      const load = caller.source.indexOf(caller.load, start);
      const staleCheck = caller.source.indexOf(caller.staleCheck, load);
      const generationCheck = caller.source.indexOf(
        caller.generationCheck,
        staleCheck,
      );
      const commit = caller.source.indexOf(caller.commit, generationCheck);
      expect(start, `${caller.name}: start`).toBeGreaterThanOrEqual(0);
      expect(load, `${caller.name}: load`).toBeGreaterThan(start);
      expect(staleCheck, `${caller.name}: stale check`).toBeGreaterThan(load);
      expect(
        generationCheck,
        `${caller.name}: generation check`,
      ).toBeGreaterThan(staleCheck);
      expect(commit, `${caller.name}: commit`).toBeGreaterThan(generationCheck);
    }

    const exportPreview = callerSlices[0].source;
    expect(exportPreview).toContain("robot.links.length > 0");
    expect(exportPreview).toContain("robot.group.children.length > 0");
    const deletion = runtimeSource.slice(
      runtimeSource.indexOf("async function deleteRobotSummary"),
      runtimeSource.indexOf("const robotSearchInput"),
    );
    expect(deletion).toContain(
      'runBestEffortCleanup("deleted robot: resource cleanup failed", () => robot.clear())',
    );
    expect(deletion).toContain('clearH2rRobotAfterViewLoss("deleted robot")');
  });

  it("withdraws logical workflow capabilities after current RobotView failures", () => {
    const h2rCleanup = runtimeSource.slice(
      runtimeSource.indexOf("function clearH2rRobotAfterViewLoss"),
      runtimeSource.indexOf("async function refreshScaledPreview"),
    );
    for (const reset of [
      "state.robot = null",
      "state.robotTrajectory = null",
      "state.exportToken = null",
      "state.exportSrcFps = null",
      "state.exportHasScene = false",
      "state.calibration = false",
      'h2rRunState = "idle"',
      'setH2rLayerVisible("targetRobot", false)',
      'clearResultDiagnostics("h2r")',
      "publishH2rWorkflowState()",
    ]) {
      expect(h2rCleanup, `H2R cleanup: ${reset}`).toContain(reset);
    }
    expect(h2rCleanup).toContain("calibManip.stop()");
    expect(h2rCleanup).toContain("_restoreVis(calibrationRestore)");
    expect(h2rCleanup).not.toContain("robot.clear()");

    const r2rCleanup = runtimeSource.slice(
      runtimeSource.indexOf("function clearR2rCalibrationAfterViewLoss"),
      runtimeSource.indexOf("async function r2rLoadSourceRobot"),
    );
    for (const reset of [
      "r2r.sourceName = null",
      "r2r.sourcePayload = null",
      "r2r.sourceToken = null",
      "r2r.sourceStem = null",
      "r2r.targetName = null",
      "r2r.targetPayload = null",
      "r2r.calibrated = false",
      "r2r.exportToken = null",
      "r2r.exportHasScene = false",
      "r2r.resultStem = null",
      "r2r.scaledScene = null",
      "r2r.tgtScaledScene = null",
      "r2rSrcSkel.clear()",
      "r2rSrcEnv.clear()",
      "r2rTgtSkel.clear()",
      "r2rTgtEnv.clear()",
    ]) {
      expect(r2rCleanup, `R2R cleanup: ${reset}`).toContain(reset);
    }
    // Preserve the visible selection so the user can retry, while canonical
    // source/target names remain null until a renderer generation commits.
    expect(r2rCleanup).not.toContain('select.value = ""');
    expect(r2rCleanup).not.toContain("r2rSrc.clear()");
    expect(r2rCleanup).not.toContain("r2rTgt.clear()");

    const currentFailureCallers = [
      {
        name: "H2R export preview",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function loadRobotExportPreview"),
          runtimeSource.indexOf("async function previewRobotClip"),
        ),
        generationGuard:
          'if (!robot.isLoadGenerationCurrent(attempt.generation)) return "stale"',
        cleanup: 'clearH2rRobotAfterViewLoss("export preview robot load")',
      },
      {
        name: "H2R robot selection",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function applyRobot"),
          runtimeSource.indexOf("async function refreshRobotList"),
        ),
        generationGuard:
          'if (!robot.isLoadGenerationCurrent(attempt.generation)) return "stale"',
        cleanup: 'clearH2rRobotAfterViewLoss("selected robot load")',
      },
      {
        name: "R2R source selection",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rLoadSourceRobot"),
          runtimeSource.indexOf("async function r2rLoadTargetRobot"),
        ),
        generationGuard:
          "if (!r2rSrc.isLoadGenerationCurrent(attempt.generation)) return",
        cleanup: 'clearR2rSourceAfterViewLoss("selected R2R source load")',
      },
      {
        name: "R2R calibration target",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rStartCalib"),
          runtimeSource.indexOf("function r2rExitCalib"),
        ),
        generationGuard: 'if (!isCurrent()) return "stale"',
        cleanup: "rollbackR2rCalibrationBootstrap(",
      },
      {
        name: "R2R automatic source",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rEnsureSourceLoaded"),
          runtimeSource.indexOf("async function r2rUploadTraj"),
        ),
        generationGuard:
          "if (!r2rSrc.isLoadGenerationCurrent(attempt.generation)) return false",
        cleanup: 'clearR2rSourceAfterViewLoss("automatic R2R source load")',
      },
      {
        name: "R2R trajectory source",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rApplySourceTrajectoryResult"),
          runtimeSource.indexOf("async function loadR2rLibraryEntry"),
        ),
        generationGuard:
          'if (!r2rSrc.isLoadGenerationCurrent(attempt.generation)) return "stale"',
        cleanup: 'clearR2rSourceAfterViewLoss("R2R trajectory source load")',
      },
      {
        name: "R2R retarget target",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rRunRetarget"),
          runtimeSource.indexOf("// --------------------------------------------------------------- batch"),
        ),
        generationGuard:
          "if (!r2rTgt.isLoadGenerationCurrent(attempt.generation)) return",
        cleanup: 'clearR2rTargetAfterViewLoss("R2R result target load")',
      },
    ] as const;
    for (const caller of currentFailureCallers) {
      const guard = caller.source.indexOf(caller.generationGuard);
      const cleanup = caller.source.indexOf(caller.cleanup, guard);
      expect(guard, `${caller.name}: generation guard`).toBeGreaterThanOrEqual(0);
      expect(cleanup, `${caller.name}: failure cleanup`).toBeGreaterThan(guard);
    }
  });
});
