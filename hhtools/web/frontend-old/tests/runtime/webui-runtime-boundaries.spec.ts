import { describe, expect, it } from "vitest";

import asyncFrameTaskSource from "../../src/runtime/stage/coalesced-async-frame-task.ts?raw";
import latestAttemptOwnerSource from "../../src/runtime/stage/latest-async-attempt-owner.ts?raw";
import latestSessionLifecycleSource from "../../src/runtime/stage/latest-session-lifecycle.ts?raw";
import reentrantSessionInstallSource from "../../src/runtime/stage/reentrant-session-install.ts?raw";
import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";
import commandRegistrySource from "../../src/runtime/command-registry.ts?raw";
import referenceSkeletonViewSource from "../../src/runtime/stage/reference-skeleton-view.ts?raw";
import robotViewSource from "../../src/runtime/stage/robot-view.ts?raw";

function expectTokensInOrder(source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor);
    expect(next, `missing ordered token: ${token}`).toBeGreaterThanOrEqual(0);
    cursor = next + token.length;
  }
}

describe("legacy runtime ownership boundaries", () => {
  it("wires DOM-free session primitives through an explicit manipulator lease API", () => {
    for (const primitive of [latestSessionLifecycleSource, reentrantSessionInstallSource]) {
      expect(primitive).not.toMatch(/\b(?:document|window|HTMLElement|THREE)\b/);
    }
    expect(latestSessionLifecycleSource).toContain("export class LatestSessionLifecycle");
    expect(latestSessionLifecycleSource).toContain("get currentCleanup()");
    expect(reentrantSessionInstallSource).toContain(
      "export function installReentrantSessionResource",
    );
    expect(reentrantSessionInstallSource).toContain(
      "export class ReentrantHostMutationGate",
    );
    expect(runtimeSource).toContain('from "./stage/latest-session-lifecycle"');
    expect(runtimeSource).toContain('"./stage/reentrant-session-install"');

    const publicCalls = [...runtimeSource.matchAll(/\bcalibManip\.([A-Za-z][A-Za-z0-9]*)\s*\(/g)]
      .map((match) => match[1]);
    expect([...new Set(publicCalls)].sort()).toEqual([
      "clearExternalRoots",
      "clearPointerPlacement",
      "isCurrent",
      "owns",
      "positionTags",
      "publishExternalRoot",
      "referenceDiagnostics",
      "referenceFacts",
      "refreshReferenceLabels",
      "reserve",
      "setAngleUnit",
      "setReferenceDisplayOptions",
      "setReferenceVisible",
      "setSelected",
      "start",
      "stop",
      "updateHudValue",
      "updateJointWorld",
      "updateReferenceOverlay",
    ]);
    expect(runtimeSource).not.toMatch(/\bcalibManip\._/);
    expect(runtimeSource).not.toMatch(/\bcalibManip\.stop\(\s*\)/);
    expect(runtimeSource).not.toMatch(
      /stopCalibrationManipulatorSession\(\s*["'](?:h2r|r2r)["']\s*\)/,
    );

    const reserveAdapter = runtimeSource.slice(
      runtimeSource.indexOf("function reserveCalibrationManipulatorSession"),
      runtimeSource.indexOf("function startReservedCalibrationManipulatorSession"),
    );
    expect(reserveAdapter.indexOf("const reservation = calibManip.reserve("))
      .toBeLessThan(reserveAdapter.indexOf("setCalibrationManipulatorAlias(workflow, session)"));

    const startAdapter = runtimeSource.slice(
      runtimeSource.indexOf("function startReservedCalibrationManipulatorSession"),
      runtimeSource.indexOf("function stopCalibrationManipulatorSession"),
    );
    expect(startAdapter.indexOf("calibrationManipulatorAlias(workflow) !== session"))
      .toBeLessThan(startAdapter.indexOf("calibManip.start(session, createContext)"));
    expect(startAdapter.indexOf("!calibManip.owns(session)"))
      .toBeLessThan(startAdapter.indexOf("calibManip.start(session, createContext)"));

    const stopAdapter = runtimeSource.slice(
      runtimeSource.indexOf("function stopCalibrationManipulatorSession"),
      runtimeSource.indexOf("function h2rCalibrationContext"),
    );
    expect(stopAdapter).toContain("expected.value.owner !== workflow");
    expect(stopAdapter.indexOf("setCalibrationManipulatorAlias(workflow, null)"))
      .toBeLessThan(stopAdapter.indexOf("return calibManip.stop(expected)"));
    expect(stopAdapter).not.toContain("expected = calibrationManipulatorAlias");

    const manipulatorSource = runtimeSource.slice(
      runtimeSource.indexOf("class CalibManipulator"),
      runtimeSource.indexOf("const calibManip = new CalibManipulator"),
    );
    expect(manipulatorSource).toContain(
      "this._sessions.current ?? this._sessions.currentCleanup",
    );
    expect(manipulatorSource).toContain(
      "this._state(expectedSession).orbitEnabledBaseline",
    );
    expect(manipulatorSource).not.toContain(
      "this._state(owned).orbitEnabledBaseline = orbit.enabled",
    );
    expectTokensInOrder(manipulatorSource.slice(
      manipulatorSource.indexOf("reserve("),
      manipulatorSource.indexOf("start("),
    ), [
      "this._referenceView.prepare(referenceSetup)",
      "this._sessions.reserve(workflow",
    ]);
    expect(runtimeSource).toContain("reference: ReferenceSkeletonResource | null");
    expect(manipulatorSource).toContain("referenceVisible: false");
    expect(manipulatorSource).toContain("this._referenceView.dispose(reference)");
  });

  it("composes extracted inert Stage Views explicitly", () => {
    expect(runtimeSource).toContain(
      'import { RobotView } from "./stage/robot-view"',
    );
    expect(runtimeSource).toContain(
      'from "./stage/reference-skeleton-view"',
    );
    expect(runtimeSource).not.toContain("class RobotView");
    expect(runtimeSource).not.toContain("class ReferenceSkeletonView");
    expect(robotViewSource).toContain("export class RobotView");
    expect(referenceSkeletonViewSource).toContain(
      "export class ReferenceSkeletonView",
    );
    expect(robotViewSource).not.toContain("world.add(");
    expect(referenceSkeletonViewSource).not.toContain("world.add(");
    expect(referenceSkeletonViewSource).not.toMatch(
      /\bdocument\.(?:getElementById|querySelector)/,
    );
    for (const injectedDependency of [
      "labelRoot,",
      "lineRoot,",
      "camera,",
      "localize,",
      "resourceDisposer,",
    ]) {
      expect(referenceSkeletonViewSource).toContain(injectedDependency);
    }
    expect(runtimeSource.match(/world\.add\(referenceSkeletonView\.group\)/g))
      .toHaveLength(1);
    expect(runtimeSource).not.toMatch(/\brefSkel\b/);
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
    expect(h2rPreview).toContain(
      "readonly manipulatorSession: CalibrationManipulatorSession",
    );
    expect(h2rPreview).toContain(
      'calibrationSessionIsCurrent("h2r", result.manipulatorSession)',
    );
    expect(h2rPreview).toContain(
      "calibManip.updateJointWorld(result.manipulatorSession",
    );
    const h2rCommit = h2rPreview.slice(
      h2rPreview.indexOf("commit: (result) =>"),
      h2rPreview.indexOf("reportError:"),
    );
    expectTokensInOrder(h2rCommit, [
      'calibrationSessionIsCurrent("h2r", result.manipulatorSession)',
      "robot.applyCalibPose(",
      'calibrationSessionIsCurrent("h2r", result.manipulatorSession)',
      "calibManip.updateReferenceOverlay(result.manipulatorSession)",
      'calibrationSessionIsCurrent("h2r", result.manipulatorSession)',
      "calibManip.updateJointWorld(",
      'calibrationSessionIsCurrent("h2r", result.manipulatorSession)',
      "updateH2rCalibrationValidation()",
      'calibrationSessionIsCurrent("h2r", result.manipulatorSession)',
    ]);
    for (const effect of [
      "robot.applyCalibPose(",
      "calibManip.updateReferenceOverlay(result.manipulatorSession)",
      "calibManip.updateJointWorld(",
      "updateH2rCalibrationValidation()",
      "applyCalibOrbitLimits({",
      "focusRobotView({",
    ]) {
      const effectAt = h2rPreview.indexOf(effect);
      expect(effectAt, `H2R FK boundary: ${effect}`).toBeGreaterThanOrEqual(0);
      expect(h2rPreview.lastIndexOf(
        'calibrationSessionIsCurrent("h2r", result.manipulatorSession)',
        effectAt,
      )).toBeGreaterThanOrEqual(0);
      expect(h2rPreview.indexOf(
        'calibrationSessionIsCurrent("h2r", result.manipulatorSession)',
        effectAt,
      )).toBeGreaterThan(effectAt);
    }
    expect(h2rPreview).toContain("state.robot !== result.activeRobot");
    expect(h2rPreview).toContain("state.motion !== result.activeMotion");
    expect(h2rPreview).toContain("state.reference !== result.reference");

    const h2rExit = runtimeSource.slice(
      runtimeSource.indexOf("function exitCalibrationMode"),
      runtimeSource.indexOf("function setCalibJointValue"),
    );
    expect(h2rExit.indexOf("h2rCalibrationManipulatorSession = null"))
      .toBeLessThan(h2rExit.indexOf("state.calibrationMode = false"));
    expect(h2rExit.indexOf("state.calibrationMode = false"))
      .toBeLessThan(h2rExit.indexOf("h2rCalibrationFkPreview.stop()"));
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
    expect(r2rPreview).toContain(
      "readonly manipulatorSession: CalibrationManipulatorSession",
    );
    expect(r2rPreview).toContain(
      'calibrationSessionIsCurrent("r2r", result.manipulatorSession)',
    );
    expect(r2rPreview).toContain(
      "calibManip.updateJointWorld(result.manipulatorSession",
    );
    const r2rCommit = r2rPreview.slice(
      r2rPreview.indexOf("commit: (result) =>"),
      r2rPreview.indexOf("reportError:"),
    );
    expectTokensInOrder(r2rCommit, [
      'calibrationSessionIsCurrent("r2r", result.manipulatorSession)',
      "r2rTgt.applyCalibPose(",
      'calibrationSessionIsCurrent("r2r", result.manipulatorSession)',
      "calibManip.updateReferenceOverlay(result.manipulatorSession)",
      'calibrationSessionIsCurrent("r2r", result.manipulatorSession)',
      "calibManip.updateJointWorld(",
      'calibrationSessionIsCurrent("r2r", result.manipulatorSession)',
      "updateR2rCalibrationValidation()",
      'calibrationSessionIsCurrent("r2r", result.manipulatorSession)',
    ]);
    for (const effect of [
      "r2rTgt.applyCalibPose(",
      "calibManip.updateReferenceOverlay(result.manipulatorSession)",
      "calibManip.updateJointWorld(",
      "updateR2rCalibrationValidation()",
      "applyCalibOrbitLimits({",
      "focusRobotView({",
    ]) {
      const effectAt = r2rPreview.indexOf(effect);
      expect(effectAt, `R2R FK boundary: ${effect}`).toBeGreaterThanOrEqual(0);
      expect(r2rPreview.lastIndexOf(
        'calibrationSessionIsCurrent("r2r", result.manipulatorSession)',
        effectAt,
      )).toBeGreaterThanOrEqual(0);
      expect(r2rPreview.indexOf(
        'calibrationSessionIsCurrent("r2r", result.manipulatorSession)',
        effectAt,
      )).toBeGreaterThan(effectAt);
    }
    expect(r2rPreview).toContain("r2r.sourceName !== result.sourceName");
    expect(r2rPreview).toContain("r2r.sourcePayload !== result.sourcePayload");
    expect(r2rPreview).toContain("r2r.targetName !== result.targetName");
    expect(r2rPreview).toContain("r2r.targetPayload !== result.targetPayload");

    const renderOwnershipLoop = runtimeSource.slice(
      runtimeSource.indexOf("function animate("),
      runtimeSource.indexOf("resize();", runtimeSource.indexOf("function animate(")),
    );
    expectTokensInOrder(renderOwnershipLoop, [
      "const manipulatorSession = calibManip.currentSession",
      "calibrationManipulatorAlias(calibrationWorkflow) === manipulatorSession",
      "calibManip.positionTags(manipulatorSession)",
      "calibrationSessionIsCurrent(calibrationWorkflow, manipulatorSession)",
      "calibManip.updateReferenceOverlay(manipulatorSession)",
    ]);

    const r2rEntry = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rStartCalib"),
      runtimeSource.indexOf("function r2rExitCalib"),
    );
    expect(r2rEntry).toContain(
      'r2r.calibrating && activeCalibrationManipulatorSession("r2r")',
    );
    expect(r2rEntry.indexOf("r2rCalibrationFkPreview.start()"))
      .toBeLessThan(r2rEntry.indexOf("r2r.calibrating = true"));
    const r2rExit = runtimeSource.slice(
      runtimeSource.indexOf("function r2rExitCalib"),
      runtimeSource.indexOf("async function r2rMaybeAutoCalib"),
    );
    expect(r2rExit.indexOf("r2rCalibrationManipulatorSession = null"))
      .toBeLessThan(r2rExit.indexOf("r2r.calibrating = false"));
    expect(r2rExit.indexOf("r2r.calibrating = false"))
      .toBeLessThan(r2rExit.indexOf("r2rCalibrationFkPreview.stop()"));
    const r2rLoss = runtimeSource.slice(
      runtimeSource.indexOf("function clearR2rCalibrationAfterViewLoss"),
      runtimeSource.indexOf("function clearR2rDerivedTargetAfterViewLoss"),
    );
    expect(r2rLoss.indexOf("r2rCalibrationFkPreview.stop()"))
      .toBeLessThan(r2rLoss.indexOf("r2r.calibrating = false"));

    expect(asyncFrameTaskSource).not.toMatch(/\b(?:document|window)\b/);
    expect(asyncFrameTaskSource).toContain("this.#session = null");
    expect(asyncFrameTaskSource).toContain("if (!this.#isCurrent(session)) return");

    const renderLoop = runtimeSource.slice(
      runtimeSource.indexOf("function animate()"),
      runtimeSource.indexOf("// =================================================================  SKELETON"),
    );
    expect(renderLoop).toContain("const manipulatorSession = calibManip.currentSession");
    expect(renderLoop).toContain("calibManip.positionTags(manipulatorSession)");
    expect(renderLoop).toContain(
      "calibrationSessionIsCurrent(calibrationWorkflow, manipulatorSession)",
    );
  });

  it("guards H2R calibration bootstrap and status publication by attempt identity", () => {
    expect(runtimeSource).toContain(
      'from "./stage/latest-async-attempt-owner"',
    );
    expect(latestAttemptOwnerSource).not.toMatch(/\b(?:document|window)\b/);
    expect(latestAttemptOwnerSource).toContain("export class LatestAsyncAttemptOwner");

    const bootstrapDefinitions = runtimeSource.slice(
      runtimeSource.indexOf("interface H2rCalibrationDomainIdentity"),
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
    expect(bootstrapDefinitions).toContain(
      "calibrationPresentationEpoch === identity.presentationEpoch",
    );
    expect(bootstrapDefinitions).toContain(
      "h2rScaledPairRevision === identity.scaledPairRevision",
    );

    const entry = runtimeSource.slice(
      runtimeSource.indexOf("async function enterCalibrationMode"),
      runtimeSource.indexOf("function updateCalibRestoreButton"),
    );
    const beginAttempt = entry.indexOf("h2rCalibrationBootstrapAttempts.begin({");
    expect(entry.indexOf("calibrationPresentationEpoch += 1"))
      .toBeLessThan(beginAttempt);
    const request = entry.indexOf('await API.post("/api/calibration/session"');
    const awaitGuard = entry.indexOf(
      'if (!requestMayPublish()) return "stale"',
      request,
    );
    const referenceValidation = entry.indexOf("if (!session.reference)", awaitGuard);
    const reservation = entry.indexOf("reserveCalibrationManipulatorSession(", referenceValidation);
    const firstSessionMutation = entry.indexOf("state.calibRestore = _snapshotVis()", reservation);
    const firstResponseMutation = entry.indexOf("state.calibLimits =", reservation);
    expect(beginAttempt).toBeGreaterThanOrEqual(0);
    expect(request).toBeGreaterThan(beginAttempt);
    expect(awaitGuard).toBeGreaterThan(request);
    expect(referenceValidation).toBeGreaterThan(awaitGuard);
    expect(reservation).toBeGreaterThan(referenceValidation);
    expect(firstSessionMutation).toBeGreaterThan(reservation);
    expect(firstResponseMutation).toBeGreaterThan(reservation);
    for (const candidateMutation of [
      "h2rCalibrationFkPreview.start()",
      "state.calibrationMode = true",
      "state.calibLimits = limits",
      "orbit.zoomSpeed = 0.022",
      "robot.groundOffset =",
      "updateCalibBanner(",
      "_applyCalibSceneLayout(",
      "updateCalibRestoreButton()",
    ]) {
      expect(
        entry.indexOf(candidateMutation),
        `H2R mutation after reservation: ${candidateMutation}`,
      ).toBeGreaterThan(reservation);
    }
    expectTokensInOrder(entry, [
      "reserveCalibrationManipulatorSession(",
      "startReservedCalibrationManipulatorSession(",
      "projectCalibrationReferenceStageVisibility()",
      "applyCalibOrbitLimits({ expectedSession: manipulatorSession })",
    ]);
    expect(entry).toContain("robot: attempt.identity.robotName");
    expect(entry).toContain("reference: attempt.identity.reference");
    expect(entry).toContain("motion_token: attempt.identity.motionToken");
    expect(entry).toContain("robotGroundOffset: robot.groundOffset");
    expect(entry).toContain(
      "const presentationEpoch = ++calibrationPresentationEpoch",
    );
    expect(entry).toContain("presentationEpoch,");
    expect(entry).not.toContain("robot: state.robot.name");
    expect(entry).not.toContain("motion_token: state.motion?.token");
    expect(entry.match(/state\.calibOrbitSaved = \{/g)).toHaveLength(1);
    expect(entry).toContain("if (enteringFresh) {");
    const catchStart = entry.lastIndexOf("} catch (error) {");
    const failureAuthority = entry.indexOf(
      "const failureWasCurrent = requestMayPublish()",
      catchStart,
    );
    const rollbackCall = entry.indexOf("rollbackH2rCalibrationBootstrap(", catchStart);
    expect(failureAuthority).toBeGreaterThan(catchStart);
    expect(rollbackCall).toBeGreaterThan(failureAuthority);
    expect(entry).toContain("const bootstrapOwnsInstalledState = (): boolean");
    expect(entry).toContain("const requestMayPublish = (): boolean");
    expectTokensInOrder(entry, [
      "const bootstrapOwnsInstalledState",
      "h2rCalibrationBootstrapAttempts.isCurrent(attempt)",
      "const requestMayPublish",
      "bootstrapOwnsInstalledState()",
      "h2rInspectorPanelIsActive()",
      "ownsPairMutation()",
    ]);

    const rollback = runtimeSource.slice(
      runtimeSource.indexOf("function rollbackH2rCalibrationBootstrap"),
      runtimeSource.indexOf("async function enterCalibrationMode"),
    );
    expect(rollback).toContain("): boolean {");
    expect(rollback).toContain("ownsInstalledState: () => boolean");
    expect(rollback).toContain("requestMayReport: () => boolean");
    expect(rollback.indexOf("if (!ownsInstalledState()) return abandonAttempt()"))
      .toBeLessThan(rollback.indexOf("h2rCalibrationFkPreview.stop()"));
    expect(rollback.indexOf("h2rCalibrationManipulatorSession = null"))
      .toBeLessThan(rollback.indexOf("calibManip.stop(manipulatorSession)"));
    expect(rollback.indexOf("calibManip.stop(manipulatorSession)"))
      .toBeLessThan(rollback.indexOf("h2rCalibrationFkPreview.stop()"));
    expect(rollback).toContain("state.calibrationMode = false");
    expect(rollback).toContain("calibManip.stop(manipulatorSession)");
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
    expect(entry).toContain("rollbackH2rCalibrationBootstrap(");
    expect(entry).toContain('? "failed"');
    expect(entry).toContain(': "stale"');
    expect(entry).toContain(
      "let manipulatorSession: CalibrationManipulatorSession | null = null",
    );
    expect(entry).not.toContain(
      '?? activeCalibrationManipulatorSession("h2r")',
    );
    expectTokensInOrder(entry.slice(rollbackCall), [
      "rollbackH2rCalibrationBootstrap(",
      "attempt,",
      "error,",
      "manipulatorSession,",
      "bootstrapOwnsInstalledState,",
      "requestMayPublish,",
    ]);
    expect(entry).toContain("let terminalCleanupAttempted = false");
    const finallyStart = entry.indexOf("} finally {");
    expect(finallyStart).toBeGreaterThan(rollbackCall);
    expectTokensInOrder(entry.slice(finallyStart), [
      "if (!manipulatorCommitted && !terminalCleanupAttempted)",
      "if (manipulatorSession)",
      "rollbackH2rCalibrationBootstrap(",
      "null,",
      "bootstrapOwnsInstalledState,",
      "requestMayPublish,",
    ]);
    expect(entry.slice(finallyStart)).toContain(
      "h2rCalibrationBootstrapAttempts.abandon(attempt)",
    );
    expect(entry).toContain("if (!manipulatorSession) {");
    expect(entry).toContain("if (!buildCalibSliders(");
    expect(entry).toContain("const manipulatorIsCurrent = (): boolean");
    expect(entry).toContain(
      'applyCalibrationVisualization("h2r", manipulatorSession)',
    );

    const sliders = runtimeSource.slice(
      runtimeSource.indexOf("function buildCalibSliders("),
      runtimeSource.indexOf("interface H2rCalibrationFkResult"),
    );
    expect(sliders).toContain("): boolean {");
    expect(sliders).toContain(
      'calibrationSessionIsCurrent("h2r", session)',
    );
    expect(sliders).toContain("isCurrent() && leaseIsCurrent()");
    expect(sliders).toContain('if (!leaseIsCurrent()) return');
    expect(sliders).toContain('root.className = "calib-slider-session"');
    expect(sliders).toContain("calibManip.publishExternalRoot(session, box, root)");
    expect(sliders).not.toContain("box.replaceChildren");

    const exit = runtimeSource.slice(
      runtimeSource.indexOf("function exitCalibrationMode"),
      runtimeSource.indexOf("function setCalibJointValue"),
    );
    expect(exit.indexOf("h2rCalibrationBootstrapAttempts.invalidate()"))
      .toBeLessThan(exit.indexOf("h2rCalibrationFkPreview.stop()"));
    expect(exit.indexOf("h2rCalibrationStatusAttempts.invalidate()"))
      .toBeLessThan(exit.indexOf("state.calibrationMode = false"));
    expect(exit.indexOf("if (finishIfSuperseded()) return", exit.indexOf(
      "calibManip.stop(manipulatorSession)",
    ))).toBeGreaterThan(exit.indexOf("calibManip.stop(manipulatorSession)"));
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
    expectTokensInOrder(motionLoad, [
      "const entryResult = await enterCalibrationMode(",
      "calibrationDraft,",
      "motionOwnsScaledPair,",
      "_applyCalibSceneLayout(motionOwnsScaledPair)",
      "refreshRetargetPanel(motionLoadIsCurrent, scaledPairRevision)",
    ]);
    expect(motionLoad).toContain("calibrationMotionLoadDisposition(");
    expect(motionLoad).toContain("state.calibrationMode,");
    expect(motionLoad).toContain('if (disposition === "stale") return "stale"');
    expect(motionLoad).toContain('if (disposition === "calibration")');
    expect(motionLoad).toContain("(state.motion?.token ?? null) === calibrationMotionToken");
    expect(motionLoad).toContain("|| state.motion?.token !== payload.token");
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
    expect(statusRefresh).toContain(
      "scaledPairRevision: refreshScaledPairRevision",
    );
    expect(statusRefresh).toContain(
      "?? ++h2rScaledPairRevision",
    );
    expectTokensInOrder(statusRefresh, [
      "claimedScaledPairRevision === undefined",
      "clearH2rScaledPreview(ownsRefreshScaledPair)",
      "if (!refreshIsCurrent() || !ownsRefreshScaledPair()) return",
      "h2rCalibrationStatusAttempts.invalidate()",
    ]);
    expect(statusRefresh).toContain("h2rInspectorPanelIsActive()");
    expectTokensInOrder(statusRefresh, [
      "const unclaimedPairWriterIsPending",
      "h2rMotionSelectionIsPending()",
      "h2rRobotExportPreviewIsPending()",
      "h2rRunState === \"running\"",
      "publishH2rWorkflowState()",
      "return",
      "h2rCalibrationStatusAttempts.invalidate()",
    ]);
    expect(statusRefresh).toContain(
      "await refreshScaledPreview(statusAttempt.identity.scaledPairRevision)",
    );
    expect(statusRefresh).toContain("ownsRefreshScaledPair");

    const recalibrate = runtimeSource.slice(
      runtimeSource.indexOf('document.getElementById("recalib-btn").onclick'),
      runtimeSource.indexOf('document.getElementById("calib-zero").onclick'),
    );
    const recalibrateAwait = recalibrate.indexOf("const st = await API.get(");
    const recalibrateGuard = recalibrate.indexOf(
      "h2rCalibrationStatusAttempts.isCurrent(statusAttempt)",
      recalibrateAwait,
    );
    const recalibrateEntry = recalibrate.indexOf("await enterCalibrationMode(");
    expect(recalibrateGuard).toBeGreaterThan(recalibrateAwait);
    expect(recalibrateEntry).toBeGreaterThan(recalibrateGuard);
    expectTokensInOrder(recalibrate.slice(recalibrateEntry), [
      "jq,",
      "() => scaledPairRevision === h2rScaledPairRevision",
    ]);
    expect(recalibrate).toContain("motion: activeMotion");
    expect(recalibrate).toContain("motionToken: activeMotion?.token ?? null");

    expect(runtimeSource).toContain("function buildCalibSliders(");
    expect(runtimeSource).not.toContain("async function buildCalibSliders(");
    expect(runtimeSource).not.toContain("await buildCalibSliders(");
    expect(runtimeSource).toContain("function exitCalibrationMode(");
    expect(runtimeSource).not.toContain("await exitCalibrationMode()");
  });

  it("makes calibration save continuations exact and neutral to a reserved successor", () => {
    const h2rSave = runtimeSource.slice(
      runtimeSource.indexOf('document.getElementById("calib-save").onclick'),
      runtimeSource.indexOf("type CompletedJob"),
    );
    expectTokensInOrder(h2rSave, [
      'activeCalibrationManipulatorSession("h2r")',
      "calibManip.referenceFacts(manipulatorSession)",
      'await API.post("/api/calibration/save"',
      'calibrationSessionIsCurrent("h2r", manipulatorSession)',
      "finalizationEpoch = calibrationPresentationEpoch + 1",
      "exitCalibrationMode(manipulatorSession)",
      "const finalizationIsCurrent",
      "renderCalibrationSaveSummary(",
    ]);
    expect(h2rSave).not.toContain(
      'if (activeCalibrationManipulatorSession("h2r")) return',
    );
    expectTokensInOrder(h2rSave.slice(h2rSave.lastIndexOf("} catch (e) {")), [
      "manipulatorSession",
      'calibrationSessionIsCurrent("h2r", manipulatorSession)',
      "responseAccepted",
      "calibrationPresentationEpoch === finalizationEpoch",
      "h2rCalibrationManipulatorSession === null",
      "r2rCalibrationManipulatorSession === null",
      "toast(errorMessage(e), true)",
    ]);
    for (const boundary of [
      'document.getElementById("calib-card")',
      'card.style.display = "none"',
      "player.setPlaying(false)",
      "robot.applyStatic()",
      "withH2rStageDisplayBatch(",
      "refreshRetargetPanel()",
      "renderCalibrationSaveSummary(",
      "updateH2rCalibrationValidation()",
      "publishH2rWorkflowState()",
      "syncBatchRefHint()",
      "toast(runtimeText(",
    ]) {
      const boundaryAt = h2rSave.indexOf(boundary);
      expect(boundaryAt, `H2R save boundary: ${boundary}`).toBeGreaterThanOrEqual(0);
      expect(h2rSave.indexOf("if (!finalizationIsCurrent()) return", boundaryAt))
        .toBeGreaterThan(boundaryAt);
    }

    const r2rSave = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rSaveCalib"),
      runtimeSource.indexOf("// --------------------------------------------------------------- trajectory IO"),
    );
    expectTokensInOrder(r2rSave, [
      'activeCalibrationManipulatorSession("r2r")',
      "calibManip.referenceFacts(manipulatorSession)",
      'await API.post("/api/r2r/calibration/save"',
      'calibrationSessionIsCurrent("r2r", manipulatorSession)',
      "finalizationEpoch = calibrationPresentationEpoch + 1",
      "r2rExitCalib({ expectedSession: manipulatorSession })",
      "const finalizationIsCurrent",
      "renderCalibrationSaveSummary(",
    ]);
    expect(r2rSave).not.toContain(
      'if (activeCalibrationManipulatorSession("r2r")) return',
    );
    expectTokensInOrder(r2rSave.slice(r2rSave.lastIndexOf("} catch (e) {")), [
      "manipulatorSession",
      'calibrationSessionIsCurrent("r2r", manipulatorSession)',
      "responseAccepted",
      "calibrationPresentationEpoch === finalizationEpoch",
      "h2rCalibrationManipulatorSession === null",
      "r2rCalibrationManipulatorSession === null",
      "toast(errorMessage(e), true)",
    ]);
    for (const boundary of [
      "renderCalibrationSaveSummary(",
      "toast(runtimeText(",
      "await r2rUpdateRetargetBtn()",
    ]) {
      const boundaryAt = r2rSave.indexOf(boundary);
      expect(boundaryAt, `R2R save boundary: ${boundary}`).toBeGreaterThanOrEqual(0);
      expect(r2rSave.indexOf("if (!finalizationIsCurrent()) return", boundaryAt))
        .toBeGreaterThan(boundaryAt);
    }
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
    expect(definitions).toContain("r2rCalibrationBootstrapAttempts.owns(attempt)");
    expect(runtimeSource).toContain("onAttemptRebound?.(attempt)");

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
      "|| r2rCalibrationBootstrapIsPending()",
    );
    expect(producerPendingGate).toBeGreaterThanOrEqual(0);
    expect(producerPendingGate).toBeLessThan(statusRequest);
    const trajectoryPendingGate = status.indexOf(
      "r2rTrajectorySelectionIsPending()",
    );
    const trajectoryValidatingGate = status.indexOf(
      'r2rTrajectoryState === "validating"',
    );
    expect(trajectoryPendingGate).toBeGreaterThanOrEqual(0);
    expect(trajectoryValidatingGate).toBeGreaterThanOrEqual(0);
    expect(trajectoryPendingGate).toBeLessThan(statusRequest);
    expect(trajectoryValidatingGate).toBeLessThan(statusRequest);
    expect(status).toContain("!r2rTrajectorySelectionIsPending()");
    expect(status).toContain('r2rTrajectoryState !== "validating"');
    expect(status).toContain("&& !r2rCalibrationBootstrapIsPending()");
    expect(status).toContain("identity.targetName");
    expect(status).toContain("identity.sourceName");
    expect(status).toContain(
      '? { owner: "retarget", attempt: retargetAttempt, calibrated }',
    );
    expect(status).toContain('owner: "calibration"');
    expect(status).toContain("attempt: statusAttempt!");
    const callerGate = status.indexOf(
      'if (!callerIsCurrent()) return { kind: "stale", receipt: null }',
    );
    expect(callerGate).toBeGreaterThanOrEqual(0);
    expect(callerGate).toBeLessThan(
      status.indexOf('document.getElementById("r2r-calib-btn")'),
    );
    expect(callerGate).toBeLessThan(
      status.indexOf("r2rCalibrationStatusAttempts.begin(identity)"),
    );
    expect(status).toContain("callerIsCurrent()\n    && !r2rTrajectorySelectionIsPending()");
    // The caller consumes this still-live receipt; finishing here would reopen
    // a microtask gap where an exit or replacement could auto-start old state.
    expect(status).not.toContain("finish(statusAttempt)");
    for (const effect of [
      "r2rSetCalChip(",
      "r2rRenderBasket()",
      "publishR2rWorkflowState(statusIsCurrent)",
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
    const statusAwait = ensure.indexOf(
      "await r2rUpdateRetargetBtn({ retargetAttempt })",
    );
    const retargetReceiptGuard = ensure.indexOf(
      "!r2rRetargetResults.isCurrent(retargetAttempt)",
      statusAwait,
    );
    const activeConsumerGuard = ensure.indexOf(
      'if (r2r.calibrating || r2rCalibrationBootstrapIsPending()) return "entered"',
      statusAwait,
    );
    const retargetReceiptBranch = ensure.indexOf(
      'if (receipt.owner === "retarget")',
      activeConsumerGuard,
    );
    const exactRetargetReceiptGuard = ensure.indexOf(
      "!r2rRetargetResults.isCurrent(receipt.attempt)",
      retargetReceiptBranch,
    );
    const hiddenStageGuard = ensure.indexOf(
      "!appliedPanelPresentationOwnsStage({",
      exactRetargetReceiptGuard,
    );
    const exactBootstrapHandoff = ensure.indexOf(
      "return r2rStartCalib({ auto })",
      hiddenStageGuard,
    );
    const receiptCheck = ensure.indexOf(
      "r2rCalibrationStatusAttempts.isCurrent(receipt.attempt)",
      statusAwait,
    );
    const bootstrapHandoff = ensure.indexOf("return r2rStartCalib({ auto })", receiptCheck);
    expect(statusAwait).toBeGreaterThanOrEqual(0);
    expect(retargetReceiptGuard).toBeGreaterThan(statusAwait);
    expect(activeConsumerGuard).toBeGreaterThan(statusAwait);
    expect(retargetReceiptBranch).toBeGreaterThan(activeConsumerGuard);
    expect(exactRetargetReceiptGuard).toBeGreaterThan(retargetReceiptBranch);
    expect(hiddenStageGuard).toBeGreaterThan(exactRetargetReceiptGuard);
    expect(exactBootstrapHandoff).toBeGreaterThan(hiddenStageGuard);
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
    const calibrationIntentGuard = entry.slice(
      entry.indexOf("const calibrationIntentIsCurrent"),
      entry.indexOf("clearR2rDerivedTargetAfterViewLoss"),
    );
    for (const guard of [
      "r2rCalibrationRevision === replacementRevision",
      "!r2rRetargetIsPending()",
      "!r2rTrajectorySelectionIsPending()",
      "!r2rSourceLoadIsPending()",
      "!r2rTargetLoadIsPending()",
    ]) {
      expect(calibrationIntentGuard).toContain(guard);
    }
    expect(calibrationIntentGuard).not.toContain("r2rStageMayHostCalibration()");
    const transientCleanup = entry.indexOf("clearR2rRetargetTransientUi(");
    const firstStageGuard = entry.indexOf("if (!r2rStageMayHostCalibration())");
    const postReservationStageGuard = entry.indexOf(
      "if (!r2rStageMayHostCalibration())",
      firstBegin,
    );
    expect(entry.indexOf("calibrationPresentationEpoch += 1"))
      .toBeLessThan(firstBegin);
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
    expect(firstStageGuard).toBeGreaterThanOrEqual(0);
    expect(firstStageGuard).toBeLessThan(transientCleanup);
    expect(transientCleanup).toBeLessThan(firstBegin);
    const postCleanupStageGuard = entry.indexOf(
      "if (!r2rStageMayHostCalibration())",
      transientCleanup,
    );
    expect(postCleanupStageGuard).toBeGreaterThan(transientCleanup);
    expect(postCleanupStageGuard).toBeLessThan(
      entry.indexOf("calibrationPresentationEpoch += 1"),
    );
    expect(postReservationStageGuard).toBeGreaterThan(firstBegin);
    expect(entry.indexOf(
      "finishR2rCalibrationBootstrapAttempt(attempt)",
      postReservationStageGuard,
    )).toBeGreaterThan(postReservationStageGuard);
    expect(postReservationStageGuard).toBeLessThan(sessionAwait);
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
    const reservation = entry.indexOf(
      "reserveCalibrationManipulatorSession(",
      wildcardBegin,
    );
    const reservationWorkflow = entry.indexOf('"r2r"', reservation);
    const actualGeneration = entry.indexOf(
      "targetLoadGeneration = targetLoadAttempt.generation",
      targetLoadStart,
    );
    const postStartGuard = entry.indexOf(
      'if (!manipulatorOwnsLease()) return "stale"',
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
    expect(reservation).toBeGreaterThan(wildcardBegin);
    expect(reservationWorkflow).toBeGreaterThan(reservation);
    expect(reservationWorkflow).toBeLessThan(targetLoadStart);
    expect(targetLoadStart).toBeGreaterThan(reservation);
    expect(targetLoadStart).toBeGreaterThan(wildcardBegin);
    expect(actualGeneration).toBeGreaterThan(targetLoadStart);
    expect(postStartGuard).toBeGreaterThan(actualGeneration);
    expect(exactBegin).toBeGreaterThan(postStartGuard);
    expect(targetLoadAwait).toBeGreaterThan(exactBegin);
    expect(entry.slice(wildcardBegin, exactBegin)).not.toContain("await ");
    const targetLoadCatch = entry.indexOf("} catch (error) {", targetLoadAwait);
    const targetLossRollback = entry.indexOf("targetViewLost: true", targetLoadCatch);
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
      "r2rCalibrationFkPreview.start()",
      "applyCalibOrbitLimits({",
      "updateR2rCalibBanner()",
      'classList.remove("hidden")',
      "r2rSetCalChip(",
      "publishR2rWorkflowState(manipulatorOwnsLease)",
      'editor.style.display = "block"',
      "startReservedCalibrationManipulatorSession(",
      "r2rApplyStage()",
      "applyCalibrationVisualization(",
      "editor.scrollIntoView(",
      "focusRobotView({",
      "toast(auto",
    ];
    for (const effect of guardedEffects) {
      const effectAt = entry.indexOf(effect);
      const tail = entry.slice(effectAt + effect.length);
      const relativeGuard = tail.search(
        /if \(!manipulator(?:OwnsLease|IsCurrent)\(\)\) return "stale"/,
      );
      expect(effectAt, `bootstrap effect: ${effect}`).toBeGreaterThanOrEqual(0);
      expect(relativeGuard, `bootstrap guard: ${effect}`).toBeGreaterThanOrEqual(0);
    }
    expect(entry).toContain("const panelSwitch = switchInspectorPanel(\"r2r\")");
    expect(entry).toContain(
      "!panelSwitchSettledOnStageOwner(panelSwitch, \"r2r\")",
    );
    expect(entry).not.toContain("r2rEnterPanel()");
    expectTokensInOrder(entry, [
      "reserveCalibrationManipulatorSession(",
      "payload: reference",
      "ikMap: targetPayload.ik_map ?? {}",
      "const targetLoadAttempt = startRobotViewLoad(r2rTgt, targetPayload)",
      "startReservedCalibrationManipulatorSession(",
      "r2rApplyStage()",
      "applyCalibOrbitLimits({ expectedSession: manipulatorSession })",
    ]);
    for (const candidateMutation of [
      "const targetLoadAttempt = startRobotViewLoad(r2rTgt, targetPayload)",
      "r2rCalibrationFkPreview.stop()",
      'switchInspectorPanel("r2r")',
      "r2r.calibrating = true",
      "r2r.calibLimits = limits",
      "r2rTgt.groundOffset =",
      'editor.style.display = "block"',
    ]) {
      expect(
        entry.indexOf(candidateMutation),
        `R2R mutation after reservation: ${candidateMutation}`,
      ).toBeGreaterThan(reservation);
    }
    expect(entry).toContain("if (!r2rBuildSliders(");
    expect(entry).toContain("manipulatorSession,");

    const sliders = runtimeSource.slice(
      runtimeSource.indexOf("function r2rBuildSliders"),
      runtimeSource.indexOf("function rollbackR2rCalibrationBootstrap"),
    );
    expect(sliders).toContain("isCurrent: () => boolean");
    expect(sliders).toContain('root.className = "calib-slider-session"');
    expect(sliders).toContain("calibManip.publishExternalRoot(session, box, root)");
    expect(sliders).not.toContain("box.replaceChildren()");
    for (const boundary of [
      "rowEl.append(label, range, num)",
      "calibManip.updateHudValue(session, j, v)",
      "root.appendChild(rowEl)",
      "calibManip.publishExternalRoot(session, box, root)",
      'applyCalibrationRowFilter("r2r")',
      "updateR2rCalibrationValidation()",
    ]) {
      const boundaryAt = sliders.indexOf(boundary);
      expect(boundaryAt, `R2R slider boundary: ${boundary}`).toBeGreaterThanOrEqual(0);
      expect(sliders.indexOf("if (!sessionIsCurrent()) return false", boundaryAt))
        .toBeGreaterThan(boundaryAt);
    }

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
    expectTokensInOrder(rollback, [
      "r2r.calibrated = sourceViewLost || targetViewLost",
      "? false",
      ": attempt.identity.calibratedBefore",
    ]);
    expect(rollback).toContain("if (!ownsAttempt()) return false");
    expect(rollback).toContain("runBestEffortCleanup(context, action)");
    expect(rollback.indexOf("r2rCalibrationManipulatorSession = null"))
      .toBeLessThan(rollback.indexOf("calibManip.stop(manipulatorSession)"));
    expect(rollback.indexOf("calibManip.stop(manipulatorSession)"))
      .toBeLessThan(rollback.indexOf("r2rCalibrationFkPreview.stop()"));
    const rollbackFinish = rollback.indexOf(
      "abandonR2rCalibrationBootstrapAttempt(attempt)",
    );
    expect(rollbackFinish).toBeGreaterThan(rollback.indexOf("toast(errorMessage(error), true)"));
    expect(rollback.indexOf("r2r.calibOrbitSaved = null")).toBeGreaterThan(rollbackFinish);
    expect(rollback.indexOf("r2rCalibrationResourcesOwned = false")).toBeGreaterThan(rollbackFinish);
    expect(rollback.indexOf("r2rCalibrationRestoreGroundOffset = null")).toBeGreaterThan(rollbackFinish);
    expect(rollback).not.toContain("clearR2rTargetAfterViewLoss(");
    expect(rollback).not.toContain("setR2rRobotStatus(");
    for (const guardedCleanup of [
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
    expect(exit.indexOf("r2rCalibrationManipulatorSession = null"))
      .toBeLessThan(exit.indexOf("r2rCalibrationFkPreview.stop()"));
    expect(exit.indexOf("r2r.calibrating = false"))
      .toBeLessThan(exit.indexOf("r2rCalibrationFkPreview.stop()"));
    expect(exit.indexOf("if (superseded()) return", exit.indexOf(
      "calibManip.stop(manipulatorSession)",
    ))).toBeGreaterThan(exit.indexOf("calibManip.stop(manipulatorSession)"));
    const leave = runtimeSource.slice(
      runtimeSource.indexOf("function r2rLeavePanel"),
      runtimeSource.indexOf("function r2rSetCalChip"),
    );
    expect(leave).toContain("|| r2rCalibrationResourcesOwned");
    expect(leave).toContain("|| r2r.calibOrbitSaved !== null");
    expect(leave.indexOf("r2r.active = false"))
      .toBeLessThan(leave.indexOf("r2rExitCalib({ publishStageDisplay: false })"));
    const replacement = runtimeSource.slice(
      runtimeSource.indexOf("function prepareR2rRobotReplacement"),
      runtimeSource.indexOf("function clearR2rCalibrationAfterViewLoss"),
    );
    expect(replacement.indexOf("r2rExitCalib()"))
      .toBeLessThan(replacement.indexOf("r2rCalibrationFkPreview.stop()"));
    expect(replacement).toContain("r2rCalibrationResourcesOwned");
    const calibrationOnlyLossCleanup = runtimeSource.slice(
      runtimeSource.indexOf("function clearR2rCalibrationAfterViewLoss"),
      runtimeSource.indexOf("function clearR2rDerivedTargetAfterViewLoss"),
    );
    expect(calibrationOnlyLossCleanup).toContain("invalidateR2rCalibrationAttempts()");
    for (const functionName of [
      "clearR2rSourceAfterViewLoss",
      "clearR2rTargetAfterViewLoss",
    ]) {
      const start = runtimeSource.indexOf(`function ${functionName}`);
      const body = runtimeSource.slice(start, runtimeSource.indexOf("\n}", start) + 2);
      expect(body).toContain("clearR2rCalibrationAfterViewLoss");
      expect(body).toContain("context, isCurrent");
    }

    const replacementLoads = [
      {
        name: "selected source",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rLoadSourceRobot"),
          runtimeSource.indexOf("async function r2rLoadTargetRobot"),
        ),
        start: "const viewAttempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        commit: "r2r.sourcePayload = sourcePayload",
      },
      {
        name: "automatic source",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rEnsureSourceLoaded"),
          runtimeSource.indexOf("function failR2rTrajectorySelection"),
        ),
        start: "const sourceViewAttempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        commit: "r2r.sourcePayload = sourcePayload",
      },
      {
        name: "retarget target",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rRunRetarget"),
          runtimeSource.indexOf("// --------------------------------------------------------------- batch"),
        ),
        start: "const targetViewAttempt = startRobotViewLoad(r2rTgt, targetPayload)",
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
      if (view.className === "EnvView") {
        expect(classSource).toContain("private preparationGeneration = 0");
        expect(classSource).toContain(
          "private readonly generations = new WeakMap<EnvViewRetirement, EnvViewGeneration>()",
        );
        expect(classSource).toContain(
          "private readonly disposedWithGeneration = new WeakSet<THREE.Object3D>()",
        );
        const clearSource = classSource.slice(
          classSource.indexOf("clear(): void {"),
          classSource.indexOf("\n  prepare("),
        );
        expectTokensInOrder(clearSource, [
          "this.preparationGeneration += 1",
          "const retired = this.content?.retirement ?? null",
          "this.content.root.visible = false",
          "this.content = null",
          "this.releaseAliases()",
          "this.retire(retired)",
        ]);
        expect(clearSource).not.toContain("this.group.clear()");
        expect(clearSource).not.toContain("disposeObject3DChildren");

        const prepareSource = classSource.slice(
          classSource.indexOf("\n  prepare("),
          classSource.indexOf("\n  retire("),
        );
        expectTokensInOrder(prepareSource, [
          "const root = new THREE.Group()",
          "root.visible = false",
          "const ownedChildren = new Set<THREE.Object3D>()",
          "object.traverse((node) => { ownedChildren.add(node); })",
          "root.add(placeholder)",
          "new DetachedSourceViewPreparation(",
        ]);

        const loadSource = classSource.slice(
          classSource.indexOf("\n  load("),
          classSource.indexOf("\n  get numFrames"),
        );
        expectTokensInOrder(loadSource, [
          "const prepared = this.prepare(motion)",
          'prepared.stage() !== "staged"',
          "const retired = prepared.publish()",
          "this.retire(retired)",
          "prepared.activate()",
          "prepared.abandon()",
        ]);

        const replacementSource = classSource.slice(
          classSource.indexOf("private commitObjectMesh("),
          classSource.indexOf("private disposeGeneration("),
        );
        expectTokensInOrder(replacementSource, [
          "const realOwnedSnapshot: THREE.Object3D[] = []",
          "real.traverse((node) => { realOwnedSnapshot.push(node); })",
          "for (const node of realOwnedSnapshot) generation.ownedChildren.add(node)",
          "generation.root.add(real)",
          "real.parent !== generation.root",
          "generation.root.remove(placeholder)",
          "generation.objectMeshes[index] !== placeholder",
          "generation.objectMeshes[index] = real",
          "this.releaseGenerationObject(",
          "placeholder",
          '"environment placeholder cleanup failed"',
        ]);
        const releaseSource = replacementSource.slice(
          replacementSource.indexOf("private releaseGenerationObject("),
        );
        expectTokensInOrder(releaseSource, [
          "for (const node of knownSubtree)",
          "generation.ownedChildren.delete(node)",
          "this.disposedWithGeneration.has(node)",
          "retireThreeContentRoot(",
          "unsettledKnownSubtree",
        ]);
        expect(replacementSource).toContain(
          "placeholder.parent === generation.root",
        );
        continue;
      }
      expect(classSource).toContain("private _loadGeneration = 0");
      if (view.className === "ScaledEnvView") {
        expect(classSource).toContain("const m = buildTerrainMesh(");
        expect(classSource).toContain("color: 0x5c7a9e");
        expect(classSource).not.toContain("m.material =");
      }

      const clearStart = classSource.indexOf(
        view.className === "ScaledEnvView"
          ? "clear(isCurrent: () => boolean = () => true): boolean {"
          : "clear(): void {",
      );
      const loadStart = classSource.indexOf("\n  load(", clearStart);
      const clearSource = classSource.slice(clearStart, loadStart);
      if (view.className === "ScaledEnvView") {
        expectTokensInOrder(clearSource, [
          "const expectedGeneration = this._loadGeneration + 1",
          "this._loadGeneration = expectedGeneration",
          "const retired = this._content",
          "this._content = null",
          "this.objectMeshes = []",
          "retireThreeContentRoot(",
          "[...retired.ownedChildren]",
          "retired.extras",
        ]);
        expect(clearSource).toContain("if (!isCurrent()) return false");
      } else {
        expect(clearSource).toContain("this._loadGeneration += 1");
        expect(clearSource).toContain(
          "threeResourceDisposer.disposeObject3DChildren(this.group)",
        );
        expect(clearSource).toContain("finally {");
        expect(clearSource).toContain("this.group.clear()");
      }
      for (const alias of view.clearedAliases) {
        expect(clearSource, `${view.className}: ${alias}`).toContain(alias);
      }
      expect(clearSource).not.toContain("while (this.group.children.length)");

      const buildStart = classSource.indexOf(
        view.className === "ScaledEnvView"
          ? "private _loadObjectMesh"
          : "private _buildObject",
        loadStart,
      );
      const loadSource = classSource.slice(loadStart, buildStart);
      const buildSource = classSource.slice(buildStart);
      if (view.className === "ScaledEnvView") {
        expectTokensInOrder(loadSource, [
          "const expectedGeneration = this._loadGeneration + 1",
          "this.clear(isCurrent)",
          "this._loadGeneration !== expectedGeneration",
          "const generation = expectedGeneration",
          "const candidate = new THREE.Group()",
          "const ownedChildren = new Set<THREE.Object3D>()",
          "candidate.add(box)",
          "this._content = content",
          "this.group.add(candidate)",
          "if (!viewIsCurrent())",
          "this.objectMeshes = objectMeshes",
          "this.objectTraj = objectTraj",
          "this._loadObjectMesh(",
        ]);
        for (const exactViewGuard of [
          "this._loadGeneration === generation",
          "this.objectMeshes === objectMeshes",
          "objectMeshes[index] === box",
          "candidate.parent === this.group",
        ]) {
          expect(buildSource).toContain(exactViewGuard);
        }
        const staleDispose = buildSource.indexOf(view.staleContext);
        const attach = buildSource.indexOf("candidate.add(real)", staleDispose);
        const detachPlaceholder = buildSource.indexOf(
          "candidate.remove(box)",
          attach,
        );
        const postAttachGuard = buildSource.indexOf(
          "if (!viewOwnsGeneration()) {",
          attach,
        );
        const publish = buildSource.indexOf(
          "objectMeshes[index] = real",
          detachPlaceholder,
        );
        const disposePlaceholder = buildSource.indexOf(
          view.placeholderContext,
          publish,
        );
        expect(staleDispose).toBeGreaterThanOrEqual(0);
        expect(attach).toBeGreaterThan(staleDispose);
        expect(postAttachGuard).toBeGreaterThan(attach);
        expect(detachPlaceholder).toBeGreaterThan(postAttachGuard);
        // The old placeholder remains the authoritative alias until removal
        // settles; only then may the real GLTF become visible to frame updates.
        expect(publish).toBeGreaterThan(detachPlaceholder);
        expect(disposePlaceholder).toBeGreaterThan(publish);
        // Attempt authority is only a pre-commit scheduling lease. The exact
        // View generation must continue accepting a GLTF after result commit.
        const meshGuard = buildSource.slice(
          buildSource.indexOf("const viewOwnsGeneration"),
          buildSource.indexOf("const placeholderIsCurrent"),
        );
        expect(meshGuard).not.toContain("isCurrent()");
        continue;
      }
    }
  });

  it("stages synchronous source Views under exact detached generation roots", () => {
    expect(runtimeSource).toContain(
      'import { ThreeResourceDisposer } from "@/platform/graphics/common/three-resource-disposer"',
    );
    expect(runtimeSource).toContain(
      "const threeResourceDisposer = new ThreeResourceDisposer()",
    );

    const synchronousViews = [
      {
        className: "SkeletonView",
        endMarker: "class EnvView",
        ownedChildren: ["ownedChildren.add(sphere)", "ownedChildren.add(lines)"],
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
        className: "CapsuleMeshView",
        endMarker: "class ScaledSkeletonView",
        ownedChildren: ["ownedChildren.add(mesh)"],
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
    ] as const;

    for (const {
      className,
      endMarker,
      ownedChildren,
      aliasReleases,
    } of synchronousViews) {
      const classStart = runtimeSource.indexOf(`class ${className}`);
      const classEnd = runtimeSource.indexOf(endMarker, classStart);
      const classSource = runtimeSource.slice(classStart, classEnd);
      const clearStart = classSource.indexOf("clear(): void {");
      const clearEnd = classSource.indexOf("\n  prepare(", clearStart);
      const clearSource = classSource.slice(clearStart, clearEnd);
      const prepareStart = clearEnd;
      const retireStart = classSource.indexOf("\n  retire(", prepareStart);
      const prepareSource = classSource.slice(prepareStart, retireStart);
      const disposeStart = classSource.indexOf("private disposeGeneration(");
      const releaseStart = classSource.indexOf("private releaseAliases(");
      const releaseSource = classSource.slice(releaseStart);

      expect(classStart, `${className} start`).toBeGreaterThanOrEqual(0);
      expect(classEnd, `${className} end`).toBeGreaterThan(classStart);
      expect(clearStart, `${className}.clear start`).toBeGreaterThanOrEqual(0);
      expect(clearEnd, `${className}.clear end`).toBeGreaterThan(clearStart);
      expect(prepareStart, `${className}.prepare start`).toBeGreaterThanOrEqual(clearEnd);
      expect(retireStart, `${className}.retire start`).toBeGreaterThan(prepareStart);
      expect(disposeStart, `${className}.dispose start`).toBeGreaterThan(retireStart);
      expect(releaseStart, `${className}.release start`).toBeGreaterThan(disposeStart);

      expectTokensInOrder(clearSource, [
        "this.preparationGeneration += 1",
        "const retired = this.content?.retirement ?? null",
        "this.content.root.visible = false",
        "this.content = null",
        "this.releaseAliases()",
        "this.retire(retired)",
      ]);
      expect(clearSource).not.toContain("while (this.group.children.length)");
      expect(clearSource).not.toContain("this.group.clear()");
      expect(clearSource).not.toContain("disposeObject3DChildren");

      expectTokensInOrder(prepareSource, [
        "const root = new THREE.Group()",
        "root.visible = false",
        "const ownedChildren = new Set<THREE.Object3D>()",
        "new DetachedSourceViewPreparation(",
      ]);
      for (const ownedChild of ownedChildren) {
        expect(prepareSource, `${className}: ${ownedChild}`).toContain(ownedChild);
      }
      expect(prepareSource).toContain("() => this.publishGeneration(candidate)");
      expect(prepareSource).toContain("() => this.disposeGeneration(candidate)");

      const disposeSource = classSource.slice(disposeStart, releaseStart);
      expectTokensInOrder(disposeSource, [
        "if (generation.retired) return",
        "generation.retired = true",
        "this.generations.delete(generation.retirement)",
        "retireThreeContentRoot(",
        "generation.root",
        "[...generation.ownedChildren]",
        "generation.extras",
      ]);
      for (const aliasRelease of aliasReleases) {
        expect(releaseSource, `${className}: ${aliasRelease}`).toContain(aliasRelease);
      }
      expect(classSource).not.toContain("this.group.clear()");
      expect(classSource).not.toContain("disposeObject3DChildren(this.group");
    }

    const preparationSource = runtimeSource.slice(
      runtimeSource.indexOf("class DetachedSourceViewPreparation"),
      runtimeSource.indexOf("// =================================================================  SKELETON"),
    );
    const stageSource = preparationSource.slice(
      preparationSource.indexOf("stage("),
      preparationSource.indexOf("\n  publish("),
    );
    const publishSource = preparationSource.slice(
      preparationSource.indexOf("\n  publish("),
      preparationSource.indexOf("\n  abandon("),
    );
    expectTokensInOrder(stageSource, [
      'this.state = "staging"',
      "this.stableOwner.add(this.candidateRoot)",
      "this.candidateRoot.parent !== this.stableOwner",
      "this.abandon()",
      'this.state = "staged"',
    ]);
    expect(publishSource).toContain("this.publishGeneration()");
    expect(publishSource).toContain("!this.canPublish()");
    expect(publishSource).not.toContain("stableOwner.add");
    expect(publishSource).not.toContain("stableOwner.remove");
    expect(publishSource).not.toContain("disposeCandidate");
    const canPublishSource = preparationSource.slice(
      preparationSource.indexOf("\n  canPublish("),
      preparationSource.indexOf("\n  abandon("),
    );
    expect(canPublishSource).toContain('this.state === "staged"');
    expect(canPublishSource).toContain(
      "this.candidateRoot.parent === this.stableOwner",
    );
    expect(canPublishSource).toContain("this.preparationIsCurrent()");
    expect(canPublishSource).not.toContain("isCurrent()");

    const scaledSkeletonStart = runtimeSource.indexOf(
      "class ScaledSkeletonView",
    );
    const scaledSkeleton = runtimeSource.slice(
      scaledSkeletonStart,
      runtimeSource.indexOf(
        "// Scaled-environment interpolation",
        scaledSkeletonStart,
      ),
    );
    const scaledSkeletonClear = scaledSkeleton.slice(
      scaledSkeleton.indexOf("clear(isCurrent: () => boolean = () => true): boolean"),
      scaledSkeleton.indexOf("\n  load("),
    );
    const scaledSkeletonLoad = scaledSkeleton.slice(
      scaledSkeleton.indexOf("\n  load("),
      scaledSkeleton.indexOf("\n  get numFrames"),
    );
    expectTokensInOrder(scaledSkeletonClear, [
      "const expectedGeneration = this._loadGeneration + 1",
      "this._loadGeneration = expectedGeneration",
      "const retired = this._content",
      "this._content = null",
      "this.spheres = []",
      "retireThreeContentRoot(",
      "[...retired.ownedChildren]",
      "retired.extras",
    ]);
    expectTokensInOrder(scaledSkeletonLoad, [
      "const expectedGeneration = this._loadGeneration + 1",
      "this.clear(isCurrent)",
      "this._loadGeneration !== expectedGeneration",
      "const candidate = new THREE.Group()",
      "const childrenKnownBeforeAdoption: THREE.Object3D[] = []",
      "candidate.add(s)",
      "candidate.add(lines)",
      "this._content = content",
      "this.group.add(candidate)",
      "if (!viewIsCurrent())",
      "this.spheres = spheres",
      "this.lineGeom = lineGeom",
      "this.lines = lines",
      "this.setFrame(0)",
    ]);

    const referenceInstall = referenceSkeletonViewSource.slice(
      referenceSkeletonViewSource.indexOf("  install({"),
      referenceSkeletonViewSource.indexOf("  /** Exact, idempotent terminal cleanup"),
    );
    const referenceDispose = referenceSkeletonViewSource.slice(
      referenceSkeletonViewSource.indexOf("  dispose(resource:"),
      referenceSkeletonViewSource.indexOf("  /** Project shared visibility"),
    );
    expect(referenceInstall).toContain("installReentrantSessionResource({");
    expectTokensInOrder(referenceInstall, [
      "published = true",
      "mark(resource!)",
      "this.group.add(record!.root)",
      "this.#labelRoot.appendChild(record!.labelLayer)",
      "this.#lineRoot.appendChild(record!.lineLayer)",
    ]);
    expectTokensInOrder(referenceDispose, [
      "this.#records.delete(resource)",
      "record.disposed = true",
      "this.group.remove(record.root)",
      "record.labelLayer.remove()",
      "record.lineLayer.remove()",
      "this.#resourceDisposer.disposeObject3DResources(",
      "record.root.clear()",
    ]);
    expect(referenceSkeletonViewSource).not.toContain("this.group.clear()");
    expect(referenceSkeletonViewSource).not.toContain("replaceChildren(");
    for (const removedBroadApi of [
      "clear(): void",
      "load(ref:",
      "configureMappings(",
    ]) {
      expect(referenceSkeletonViewSource).not.toContain(removedBroadApi);
    }
  });

  it("terminally disposes every calibration limit-gizmo GPU resource", () => {
    const manipulatorSource = runtimeSource.slice(
      runtimeSource.indexOf("class CalibManipulator"),
      runtimeSource.indexOf("const calibManip = new CalibManipulator"),
    );
    const initStart = manipulatorSource.indexOf("private _initLimitGizmo(");
    const disposeStart = manipulatorSource.indexOf("private _disposeLimitGizmo(");
    const buildTagsStart = manipulatorSource.indexOf("private _buildTags(");
    const initSource = manipulatorSource.slice(initStart, disposeStart);
    const disposeSource = manipulatorSource.slice(disposeStart, buildTagsStart);

    expect(initStart).toBeGreaterThanOrEqual(0);
    expect(disposeStart).toBeGreaterThan(initStart);
    expect(buildTagsStart).toBeGreaterThan(disposeStart);
    expect(initSource.match(/new THREE\.(?:LineBasic|MeshBasic)Material/g))
      .toHaveLength(5);

    const detach = disposeSource.indexOf("world.remove(owned.group)");
    const disposeResources = disposeSource.indexOf(
      "threeResourceDisposer.disposeObject3DResources(owned.group)",
    );
    const reportErrors = disposeSource.indexOf(
      'throw new AggregateError(errors, "Failed to dispose calibration limit gizmo")',
    );
    expect(initSource).toContain("ownGeometry(");
    expect(initSource).toContain("ownMaterial(");
    expect(initSource).toContain("disposeObject3DResources(g, extras)");
    expect(initSource).toContain("installReentrantSessionResource({");
    expect(detach).toBeGreaterThanOrEqual(0);
    expect(disposeResources).toBeGreaterThan(detach);
    expect(reportErrors).toBeGreaterThan(disposeResources);

    expect(disposeSource).not.toContain(".geometry.dispose()");
    expect(disposeSource).not.toContain(".material.dispose()");
  });

  it("terminalizes card, track, and canvas pointer gestures under one owner", () => {
    const manipulatorSource = runtimeSource.slice(
      runtimeSource.indexOf("type CalibrationPointerGestureEnd"),
      runtimeSource.indexOf("const calibManip = new CalibManipulator"),
    );
    for (const kind of ['readonly kind: "card"', 'readonly kind: "track"', 'readonly kind: "canvas"']) {
      expect(manipulatorSource).toContain(kind);
    }
    for (const ownedField of [
      "readonly pointerId: number",
      "readonly captureTarget: HTMLElement",
      "readonly context: CalibrationContext",
      "readonly session: CalibrationManipulatorSession",
      "orbitEnabledBefore: boolean",
      "new LatestPointerGestureOwner<CalibrationPointerGesture>()",
    ]) expect(manipulatorSource).toContain(ownedField);

    const lostCaptureSource = manipulatorSource.slice(
      manipulatorSource.indexOf("const onLostPointerCapture ="),
      manipulatorSource.indexOf("const registrations:"),
    );
    expect(lostCaptureSource).toContain("this._gestureOwner.capture");
    expect(lostCaptureSource).toContain("matchesOwnedPointerCaptureLoss(gesture, pointerEvent)");
    expect(lostCaptureSource).toContain("retargets the event to its ownerDocument");
    expect(lostCaptureSource).toContain(
      "gesture.captureTarget.hasPointerCapture(gesture.pointerId)",
    );

    const startSource = manipulatorSource.slice(
      manipulatorSource.indexOf("reserve("),
      manipulatorSource.indexOf("private _state("),
    );
    expect(startSource).toContain("this._sessions.reserve(workflow");
    expect(startSource).toContain("createContext(owned)");
    expect(startSource).toContain("this._initLimitGizmo(owned, authority)");
    expect(startSource).toContain("this._buildTags(owned, authority)");
    expect(startSource).toContain("this._installSessionListeners(owned, authority)");
    expect(manipulatorSource).not.toContain("beginSession()");
    expect(manipulatorSource).toContain("installReentrantSessionResource({");
    expect(manipulatorSource).toContain("new ReentrantHostMutationGate()");
    expect(manipulatorSource).toContain("reserveCapture(owned)");
    expect(manipulatorSource).toContain("cause === \"returned\"");

    const stopSource = manipulatorSource.slice(
      manipulatorSource.indexOf("stop(session: CalibrationManipulatorSession)"),
      manipulatorSource.indexOf("private _initLimitGizmo"),
    );
    expect(stopSource).toContain("return this._sessions.stop(session) === \"stopped\"");
    expect(stopSource).not.toContain("stop():");

    const sessionCleanup = manipulatorSource.slice(
      manipulatorSource.indexOf("private _cleanupSession("),
      manipulatorSource.indexOf("\n  setAngleUnit("),
    );
    const takeContext = sessionCleanup.indexOf("state.context = null");
    const finishGesture = sessionCleanup.indexOf("this._gestureOwner.finish(gesture)");
    const removeListeners = sessionCleanup.indexOf("registration.target.removeEventListener(");
    const removeHud = sessionCleanup.indexOf("hudRoot.remove()");
    const removeExternalRoots = sessionCleanup.indexOf("root.remove()");
    const disposeGizmo = sessionCleanup.indexOf("this._disposeLimitGizmo(limitGroup)");
    const reconcileSurface = sessionCleanup.indexOf("this._reconcileSharedSurface(null, context)");
    expect(takeContext).toBeGreaterThanOrEqual(0);
    expect(finishGesture).toBeGreaterThan(takeContext);
    expect(removeListeners).toBeGreaterThan(finishGesture);
    expect(removeHud).toBeGreaterThan(removeListeners);
    expect(removeExternalRoots).toBeGreaterThan(removeHud);
    expect(disposeGizmo).toBeGreaterThan(removeExternalRoots);
    expect(reconcileSurface).toBeGreaterThan(disposeGizmo);
    expect(sessionCleanup).toContain("authority.isHandoffCurrent()");
    expect(sessionCleanup).toContain("throw new AggregateError(");

    const beginSource = manipulatorSource.slice(
      manipulatorSource.indexOf("private _beginPointerGesture"),
      manipulatorSource.indexOf("private _cleanupPointerGesture"),
    );
    const publishGesture = beginSource.indexOf("this._gestureOwner.begin(gesture)");
    const validateExpectedSession = beginSource.indexOf(
      "gesture.session !== expectedSession",
    );
    const inheritOrbit = beginSource.indexOf("inheritedPointerGestureOrbitBaseline(");
    const cleanupPrevious = beginSource.indexOf("this._cleanupPointerGesture(");
    const reconcileOrbit = beginSource.indexOf("this._reconcileOrbit()");
    const reserveCapture = beginSource.indexOf("this._gestureOwner.reserveCapture(owned)");
    const requestCapture = beginSource.indexOf("this._requestPointerGestureCapture(owned)");
    expect(validateExpectedSession).toBeGreaterThanOrEqual(0);
    expect(validateExpectedSession).toBeLessThan(publishGesture);
    expect(beginSource).toContain("this._state(expectedSession).context !== gesture.context");
    expect(inheritOrbit).toBeGreaterThan(publishGesture);
    expect(inheritOrbit).toBeLessThan(cleanupPrevious);
    expect(cleanupPrevious).toBeGreaterThan(publishGesture);
    expect(beginSource).toContain("cleanupReplacedPointerGestureOrRollback(");
    expect(reconcileOrbit).toBeGreaterThan(cleanupPrevious);
    expect(reserveCapture).toBeGreaterThan(reconcileOrbit);
    expect(requestCapture).toBeGreaterThan(reserveCapture);
    expect(manipulatorSource).toContain("installReentrantSessionResource({");
    expect(manipulatorSource).toContain("cause === \"returned\"");
    expect(beginSource).toContain("if (!this._isCurrentPointerGesture(owned))");
    expect(beginSource).toContain("this._gestureOwner.takeCapture(owned)");

    const cleanupSource = manipulatorSource.slice(
      manipulatorSource.indexOf("private _cleanupPointerGesture"),
      manipulatorSource.indexOf("private _finishPointerGesture("),
    );
    for (const cleanup of [
      'classList.remove("is-dragging")',
      'classList.remove("track-dragging")',
      "successor.card === gesture.card",
      "successor.tag?.el === gesture.tag?.el",
      "this._projectPointerGestureSharedState(",
      "this._reconcilePointerGestureClasses()",
      "this._reconcileSharedSurface()",
      "this._reconcileOrbit({",
      "this._gestureOwner.isTransitionCurrent(handoff)",
      "this._gestureOwner.takeCapturePhase(owned)",
      "gesture.captureTarget.releasePointerCapture(gesture.pointerId)",
    ]) expect(cleanupSource).toContain(cleanup);
    const projectShared = cleanupSource.indexOf(
      "this._projectPointerGestureSharedState(",
    );
    const takeCapture = cleanupSource.indexOf("this._gestureOwner.takeCapturePhase(owned)");
    const releaseCapture = cleanupSource.indexOf("releasePointerCapture");
    expect(projectShared).toBeGreaterThanOrEqual(0);
    expect(takeCapture).toBeGreaterThan(projectShared);
    expect(releaseCapture).toBeGreaterThan(takeCapture);

    const requestCaptureSource = manipulatorSource.slice(
      manipulatorSource.indexOf("private _releasePointerGestureCapture"),
      manipulatorSource.indexOf("private _finishPointerGesture("),
    );
    for (const captureContract of [
      'phase !== "installed"',
      "samePointerCaptureIdentity(retired.value, successor.value)",
      "mayAdoptReturnedCapture",
      "this._gestureOwner.markCaptureInstalled(successor)",
      "this._gestureOwner.capturePhaseOf(owned)",
      "this._pointerCaptureGate.isInsideHostMutation",
      "this._pointerCaptureGate.deferUntilIdle()",
      "this._gestureOwner.beginCaptureInstall(owned)",
      "this._gestureOwner.markCaptureInstalled(owned)",
      "this._pointerCaptureGate.run(",
      "this._flushDeferredPointerGestureCapture()",
    ]) expect(requestCaptureSource).toContain(captureContract);

    const finishSource = manipulatorSource.slice(
      manipulatorSource.indexOf("private _finishPointerGesture("),
      manipulatorSource.indexOf("private _finishPointerGestureForReplacement"),
    );
    const takeGesture = finishSource.indexOf("this._gestureOwner.finish(owned)");
    const cleanupGesture = finishSource.indexOf("this._cleanupPointerGesture(owned, handoff, sessionAuthority)");
    const completeOnly = finishSource.indexOf('reason === "complete"');
    const flush = finishSource.indexOf("gesture.context.previewFk({ flush: true })");
    expect(cleanupGesture).toBeGreaterThan(takeGesture);
    expect(completeOnly).toBeGreaterThan(cleanupGesture);
    expect(flush).toBeGreaterThan(completeOnly);
    expect(finishSource).toContain('gesture.kind !== "card"');
    expect(finishSource).toContain("this._gestureOwner.isTransitionCurrent(handoff)");
    expect(finishSource).toContain("this._state(gesture.session).context === gesture.context");

    const hudBindings = manipulatorSource.slice(
      manipulatorSource.indexOf("private _bindHudCardDrag"),
      manipulatorSource.indexOf("\n  setSelected("),
    );
    expect(hudBindings).not.toContain('addEventListener("pointermove"');
    expect(hudBindings).not.toContain('addEventListener("pointerup"');
    expect(hudBindings).not.toContain('addEventListener("pointercancel"');
    expect(hudBindings.match(/e\.button !== 0/g)).toHaveLength(2);
    expect(hudBindings).toContain("this.setSelected(session, name, { gesture: owned })");
    expect(hudBindings.match(/context: CalibrationContext/g)).toHaveLength(2);
    expect(hudBindings.match(/session: CalibrationManipulatorSession/g)).toHaveLength(2);
    expect(hudBindings).toContain("this._state(session).context === context");
    expect(hudBindings).toContain("this.isCurrent(session)");

    const buildTagsSource = manipulatorSource.slice(
      manipulatorSource.indexOf("private _buildTags("),
      manipulatorSource.indexOf("\n  setAngleUnit("),
    );
    expect(buildTagsSource).toContain("const state = this._state(session)");
    expect(buildTagsSource).toContain("const context = state.context");
    expect(buildTagsSource).toContain("state.hudRoot = root");
    expect(buildTagsSource).toContain("this.hud.appendChild(root)");
    expect(buildTagsSource).not.toContain("replaceChildren");
    expect(buildTagsSource).toContain(
      "this._bindHudCardDrag(card, head, context, session)",
    );
    expect(buildTagsSource).toContain(
      "this._bindHudTrackDrag(name, track, thumb, meta, tag, context, session)",
    );
    const releaseLocalRoot = buildTagsSource.slice(
      buildTagsSource.indexOf("const releaseLocalRoot ="),
      buildTagsSource.indexOf("\n    try {", buildTagsSource.indexOf("const releaseLocalRoot =")),
    );
    expect(releaseLocalRoot.indexOf("state.hudRoot = null"))
      .toBeLessThan(releaseLocalRoot.indexOf("root.remove()"));

    const externalRootsSource = manipulatorSource.slice(
      manipulatorSource.indexOf("clearExternalRoots("),
      manipulatorSource.indexOf("private _perpRef("),
    );
    const clearRootsSource = externalRootsSource.slice(
      0,
      externalRootsSource.indexOf("publishExternalRoot("),
    );
    expect(clearRootsSource.indexOf("inventory.splice(index, 1)"))
      .toBeLessThan(clearRootsSource.indexOf("root.remove()"));
    const publishRootSource = externalRootsSource.slice(
      externalRootsSource.indexOf("publishExternalRoot("),
    );
    const publishRootCatch = publishRootSource.slice(
      publishRootSource.indexOf("} catch (error) {"),
    );
    expect(publishRootCatch.indexOf("roots.splice(index, 1)"))
      .toBeLessThan(publishRootCatch.indexOf("root.remove()"));

    const setSelectedSource = manipulatorSource.slice(
      manipulatorSource.indexOf("\n  setSelected("),
      manipulatorSource.indexOf("private _syncHighlights"),
    );
    expect(setSelectedSource).toContain("session: CalibrationManipulatorSession");
    expect(setSelectedSource).toContain("gesture?: OwnedCalibrationPointerGesture | null");
    expect(setSelectedSource).toContain("const context = gesture?.value.context ?? state.context");
    expect(setSelectedSource).toContain("const tags = [...state.tags.entries()]");
    expect(setSelectedSource).toContain("const sliderRows = context.getSliderRows()");
    expect(setSelectedSource).toContain("this._reconcileSelectionProjection(session, gesture)");

    const positionTagsSource = manipulatorSource.slice(
      manipulatorSource.indexOf("\n  positionTags("),
      manipulatorSource.indexOf("private _pointerNdc"),
    );
    for (const snapshot of [
      "const selected = state.selected",
      "const tags = [...state.tags.entries()]",
      "const jointWorld = state.jointWorld",
      "const hudPinned = state.hudPinned",
      "const pickAnchor = state.pickAnchor?.clone()",
    ]) expect(positionTagsSource).toContain(snapshot);
    expect(positionTagsSource).toContain(
      "this._applyHudPin(session, el, hudPinned.x, hudPinned.y, layout, gesture)",
    );
    expect(positionTagsSource).toContain("const actionIsCurrent = (): boolean");

    const canvasPointers = manipulatorSource.slice(
      manipulatorSource.indexOf("private _pointerDown"),
      manipulatorSource.indexOf("private _applyDrag"),
    );
    expect(canvasPointers).toContain(
      "if (!eventSessionIsCurrent() || e.button !== 0) return",
    );
    expect(canvasPointers).toContain(
      "this._pickMeshes(session, e.clientX, e.clientY)",
    );
    expect(canvasPointers).toContain("this._beginPointerGesture(gesture, session)");
    expect(canvasPointers).toContain("if (e.pointerId !== gesture.pointerId) return");
    expect(canvasPointers).toContain("event.pointerId !== owned.value.pointerId");
    expect(canvasPointers).toContain(
      "this.setSelected(session, joint, { scrollPanel: true, gesture: owned })",
    );
    expect(canvasPointers).toContain("this.positionTags(session, owned)");
    const prismaticStart = canvasPointers.indexOf('meta.type === "prismatic"');
    const prismaticEnd = canvasPointers.indexOf("return;", prismaticStart);
    expect(prismaticStart).toBeGreaterThanOrEqual(0);
    expect(canvasPointers.slice(prismaticStart, prismaticEnd)).not.toContain(
      "orbit.enabled = false",
    );
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
    expect(focus).toContain(": activeRobotFocusGroups()");
    expect(focus).toContain("calibManip.referenceFacts(session)");
    expect(focus).toContain("focusGroups.push(reference.object)");
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
    const reservationStart = runtimeSource.indexOf(
      "export function reserveHumanMotionPresentation",
    );
    const presentationStart = runtimeSource.indexOf(
      "async function presentReservedHumanMotion",
      reservationStart,
    );
    const facadeStart = runtimeSource.indexOf(
      "export async function presentHumanMotion",
      presentationStart,
    );
    const end = runtimeSource.indexOf("function datasetSceneGlbUrl", facadeStart);
    const reservation = runtimeSource.slice(reservationStart, presentationStart);
    const presentation = runtimeSource.slice(presentationStart, facadeStart);
    const facade = runtimeSource.slice(facadeStart, end);

    expect(reservationStart).toBeGreaterThanOrEqual(0);
    expect(presentationStart).toBeGreaterThan(reservationStart);
    expect(facadeStart).toBeGreaterThan(presentationStart);
    expect(end).toBeGreaterThan(facadeStart);
    expectTokensInOrder(reservation, [
      'beginH2rMotionSelection("presentation", label)',
      "publishH2rWorkflowState()",
      "if (commitPromise) return commitPromise",
      "commitPromise = presentReservedHumanMotion(payload, attempt)",
      "h2rMotionSelectionAttempts.abandon(attempt)",
    ]);
    expect(presentation).not.toContain("beginH2rMotionSelection(");
    expectTokensInOrder(presentation, [
      "await loadMotionPayload(payload, attempt)",
      'loadResult === "stale"',
      "await refreshLibrary()",
      "addToBasket([payload.library_entry]",
      "finishH2rMotionSelection(attempt)",
      "publishLatestH2rMotionSelectionCompletion(attempt)",
      "h2rMotionSelectionLeaseIsLatest(attempt)",
      'return "presented"',
    ]);
    expect(presentation).toContain("{ silent: true }");
    expectTokensInOrder(facade, [
      'reserveHumanMotionPresentation("generated motion")',
      "await reservation.commit(payload)",
      "reservation.dispose()",
    ]);
  });

  it("reserves one owner across every H2R motion acquisition path", () => {
    const ownership = runtimeSource.slice(
      runtimeSource.indexOf("type H2rMotionSelectionKind"),
      runtimeSource.indexOf("function datasetSceneGlbUrl"),
    );
    expect(ownership).toContain(
      "new LatestAsyncCompletionLeaseOwner<\n  H2rMotionSelectionIdentity",
    );
    const begin = ownership.slice(
      ownership.indexOf("function beginH2rMotionSelection"),
      ownership.indexOf("function h2rMotionSelectionIsCurrent"),
    );
    expectTokensInOrder(begin, [
      "const motionInputRevision = ++h2rMotionInputRevision",
      "const scaledPairRevision = ++h2rScaledPairRevision",
      "const loadingOverlayClaim = claimLoadingOverlayPresentation()",
      "h2rMotionSelectionAttempts.begin(",
      'h2rRunState = "idle"',
      "pendingH2rPlayback = null",
    ]);
    const pairPreparation = ownership.slice(
      ownership.indexOf("function prepareH2rMotionSelection"),
      ownership.indexOf("function finishH2rMotionSelection"),
    );
    expect(pairPreparation).toContain(
      "clearH2rScaledPreview(ownsPairMutation)",
    );

    const library = runtimeSource.slice(
      runtimeSource.indexOf("async function loadLibraryEntryRequest"),
      runtimeSource.indexOf("async function loadLibraryEntry("),
    );
    expectTokensInOrder(library, [
      'beginH2rMotionSelection("library", "library motion")',
      "const label = entry.stem",
      "showLoading(",
      'API.post("/api/motion/load_library"',
      "await waitMotionJob<MotionPayload>",
      "await loadMotionPayload(payload, attempt)",
      "finishH2rMotionSelection(attempt)",
    ]);

    const ingest = runtimeSource.slice(
      runtimeSource.indexOf("async function ingestMotionFiles"),
      runtimeSource.indexOf("function initMotionImportZone"),
    );
    expectTokensInOrder(ingest, [
      "beginH2rMotionSelection(",
      "inferLibraryFolderLabel(files)",
      "showLoading(",
      "await uploadFilesXHR(",
      "await waitMotionJob<MotionPayload>",
      "await loadMotionPayload(payload, attempt)",
      "finishH2rMotionSelection(attempt)",
    ]);
    expect(runtimeSource).toContain(
      "if (h2rMotionSelectionIsPending()) return runtimeText(",
    );
    const retarget = runtimeSource.slice(
      runtimeSource.indexOf('document.getElementById("retarget-btn").onclick'),
      runtimeSource.indexOf("function csvHeaderEnabled"),
    );
    expectTokensInOrder(retarget, [
      "h2rMotionSelectionIsPending()",
      "h2rRobotExportPreviewIsPending()",
      "const retargetMotionInputRevision = h2rMotionInputRevision",
      "const retargetScaledPairRevision = ++h2rScaledPairRevision",
      "retargetMotionInputRevision === h2rMotionInputRevision",
      "retargetScaledPairRevision === h2rScaledPairRevision",
    ]);
  });

  it("publishes one complete H2R source bundle before fallible presentation", () => {
    const motionLoad = runtimeSource.slice(
      runtimeSource.indexOf("async function loadMotionPayload"),
      runtimeSource.indexOf("export interface HumanMotionPresentationReservation"),
    );
    const commitStart = motionLoad.indexOf("async function commitMotionPayload");
    const preparation = motionLoad.slice(0, commitStart);
    const commit = motionLoad.slice(commitStart);

    expectTokensInOrder(preparation, [
      "prepared.skeleton = skel.prepare(payload, 0x0a84ff)",
      "prepared.capsule = mesh.prepare(payload)",
      "prepared.environment = envView.prepare(payload)",
      "await skin.prepareDetached(",
      'skinPreparation.status === "stale"',
      "prepared.skin = skinPreparation.preparation",
      "return await commitMotionPayload(",
      "abandonH2rSourceBundle(prepared)",
    ]);
    expectTokensInOrder(commit, [
      "stageH2rSourceBundle(preparedSource, motionLoadIsCurrent)",
      "h2rSourceBundleCanPublish(preparedSource)",
      "publishH2rSourceBundle(preparedSource)",
      "state.motion = payload",
      "state.robotTrajectory = null",
      "state.exportToken = null",
      "robot.trajectory = null",
      "applyLoadedH2rMotionVisibility(payload)",
      "h2rSourceBundleIsPublishedCurrent(preparedSource)",
      "markH2rStageDisplayChanged()",
      "retireH2rSourceBundle(retiredSource)",
      "preparedSource.environment.activate()",
      "syncRefSelect()",
      "if (wasCalibrating)",
      "payload.suggested_backend",
    ]);
    expect(commit).not.toContain("skel.load(");
    expect(commit).not.toContain("mesh.load(");
    expect(commit).not.toContain("envView.load(");
    expect(commit).not.toContain("skin.clear()");
    expect(commit).not.toContain("preparedSource.skin.commit(");

    const libraryLoad = runtimeSource.slice(
      runtimeSource.indexOf("async function loadLibraryEntryRequest"),
      runtimeSource.indexOf("async function loadLibraryEntry(",
        runtimeSource.indexOf("async function loadLibraryEntryRequest")),
    );
    expect(libraryLoad).toContain('loadResult === "stale"');
    expect(libraryLoad).toContain("loadMotionPayload(payload, attempt)");

    const ingest = runtimeSource.slice(
      runtimeSource.indexOf("async function ingestMotionFiles"),
      runtimeSource.indexOf("function initMotionImportZone"),
    );
    const ingestGuard = ingest.indexOf(
      'loadResult === "stale"',
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
    expect(apply).toContain("projectCalibrationReferenceStageVisibility()");
    expect(apply).toContain("if (!surface.empty)");
    expect(apply.match(/markH2rStageDisplayChanged\(\)/g)).toHaveLength(3);
  });

  it("publishes R2R ownership only around a complete H2R handoff", () => {
    const navigation = runtimeSource.slice(
      runtimeSource.indexOf("interface PanelSwitchReceipt"),
      runtimeSource.indexOf("/** After a robot is loaded"),
    );
    const enter = runtimeSource.slice(
      runtimeSource.indexOf("function r2rEnterPanel"),
      runtimeSource.indexOf("function r2rLeavePanel"),
    );
    const leave = runtimeSource.slice(
      runtimeSource.indexOf("function r2rLeavePanel"),
      runtimeSource.indexOf("function r2rSetCalChip"),
    );

    expectTokensInOrder(navigation, [
      "createPanelPresentationIntent({",
      "panelPresentationCoordinator.publish(intent)",
      "reconcilePresentationWithFinalizer(",
      "panelPresentationCoordinator,",
      "runCurrentPanelFollowups,",
    ]);
    expect(navigation).toContain("window.__hhUi?.setActivePanel(intent.panelId)");
    expect(navigation).toContain("if (!authority.isCurrent()) return");
    expect(navigation).toContain("appliedPanelPresentationOwnsStage({");
    expect(navigation).toContain('operation.value.panelId !== "h2r"');
    expect(navigation).toContain("h2rPanelRefreshDeferred = true");
    expect(navigation).toContain("h2rMotionSelectionIsPending()");
    expect(navigation).toContain("h2rRobotExportPreviewIsPending()");
    expect(navigation).toContain("const panelIsCurrent = (): boolean => (");
    expect(navigation).toContain(
      "panelPresentationCoordinator.isCurrent(operation)",
    );
    expect(runtimeSource.match(/__hhUi\?\.setActivePanel/g)).toHaveLength(1);
    expect(runtimeSource).not.toContain("inspectorPanelSwitchHook");
    expect(runtimeSource).not.toContain("panelSwitchReceiptIsCurrent");
    expect(runtimeSource).not.toContain("_r2rMainSnap");
    expect(runtimeSource.match(/if \(!r2r\.active\) r2rEnterPanel\(\)/g))
      .toBeNull();

    const relinquish = enter.indexOf("h2rOwnsStage = false");
    const hideH2rViews = enter.indexOf("applyH2rPhysicalVisibility()");
    const applyR2r = enter.indexOf("r2rApplyStage()");
    expect(relinquish).toBeLessThan(hideH2rViews);
    expect(hideH2rViews).toBeLessThan(applyR2r);
    expect(enter).toContain("if (intent.resetSharedPlayback)");
    expect(enter).toContain("pendingR2rPlaybackClaimFor(playback)");
    expect(enter).toContain("r2rPlaybackClaimIsCommitted(playbackClaim)");
    expectTokensInOrder(enter, [
      "r2rApplyStage()",
      "if (!projectionIsCurrent()) return null",
      "player.ready(playback.duration)",
      "if (!projectionIsCurrent()) return null",
      "player.seek(playback.duration > 0 ? playback.t / playback.duration : 0)",
      "if (!projectionIsCurrent()) return null",
      "_setPlaybarVisible(playback.playbarVisible)",
      "if (!projectionIsCurrent()) return null",
      "player.setPlaying(playback.playing)",
      "if (!projectionIsCurrent()) return null",
    ]);
    expect(enter).not.toContain("markH2rStageDisplayChanged()");
    expect(leave).toContain(
      "r2rApplyStage({ publishStageDisplay: false })",
    );
    expect(leave).toContain("if (intent.restoreH2rPlayer)");
    expect(leave).toContain("const baseline = intent.h2rReturnBaseline");
    expect(leave.indexOf("h2rOwnsStage = true")).toBeLessThan(
      leave.indexOf("applyH2rPhysicalVisibility()"),
    );
    expect(leave.indexOf("applyH2rPhysicalVisibility()")).toBeLessThan(
      leave.indexOf("presentPendingH2rPlayback("),
    );
    expect(leave.indexOf("presentPendingH2rPlayback(")).toBeLessThan(
      leave.indexOf('"H2R panel hand-back frame refresh failed"'),
    );
    expect(leave.indexOf('"H2R panel hand-back frame refresh failed"')).toBeLessThan(
      leave.indexOf("markH2rStageDisplayChanged()"),
    );
    expect(
      [...runtimeSource.matchAll(/\bh2rOwnsStage\s*=\s*(true|false)/g)]
        .map((match) => match[1]),
    ).toEqual(["true", "false", "true"]);

    const init = runtimeSource.slice(runtimeSource.indexOf("(async function init()"));
    expect(init.indexOf("switchInspectorPanel(initialWorkspacePreferences.activePanel)"))
      .toBeLessThan(init.indexOf("await verifyUiBuild()"));
    expect(runtimeSource).not.toContain(
      'window.addEventListener("hhtools:panel-request"',
    );

    const trajectoryRunner = runtimeSource.slice(
      runtimeSource.indexOf("async function runR2rTrajectorySelection"),
      runtimeSource.indexOf("function r2rApplySourceTrajectoryResult"),
    );
    const trajectoryUpload = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rUploadTraj"),
      runtimeSource.indexOf("async function pickR2rTrajectory"),
    );
    const librarySelection = runtimeSource.slice(
      runtimeSource.indexOf("async function loadR2rLibraryEntry"),
      runtimeSource.indexOf("async function r2rUploadTraj"),
    );
    expectTokensInOrder(trajectoryRunner, [
      "beginR2rTrajectorySelection(",
      "await r2rEnsureSourceLoaded(",
      "trajectoryAttempt",
      "(latestAttempt) => { trajectoryAttempt = latestAttempt; }",
      'switchInspectorPanel("r2r")',
      'panelSwitchSettledOnStageOwner(panelSwitch, "r2r")',
      'r2rTrajectoryState = "validating"',
    ]);
    for (const candidate of [trajectoryUpload, librarySelection]) {
      expect(candidate).toContain("runR2rTrajectorySelection({");
    }
  });

  it("gives R2R source trajectories exact async and presentation ownership", () => {
    const sourceOwnership = runtimeSource.slice(
      runtimeSource.indexOf("type R2rSourceLoadKind"),
      runtimeSource.indexOf("type R2rTrajectorySelectionKind"),
    );
    expect(sourceOwnership).toContain("new LatestAsyncAttemptOwner<");
    expect(sourceOwnership).toContain("function beginR2rSourceLoad(");
    expect(sourceOwnership).toContain("function finishR2rSourceLoad(");
    expect(sourceOwnership).toContain("function r2rSourceLoadIsPending()");
    expect(sourceOwnership).toContain(
      "attempt !== null && r2rSourceLoadAttempts.owns(attempt)",
    );

    const ownership = runtimeSource.slice(
      runtimeSource.indexOf("type R2rTrajectorySelectionKind"),
      runtimeSource.indexOf("interface R2rCalibrationIdentity"),
    );
    for (const identityFact of [
      "sourceName",
      "sourcePayload",
      "sourceViewGeneration",
      "sourceAliasesCommitted",
    ]) {
      expect(ownership).toContain(identityFact);
    }
    expect(ownership).toContain("new LatestAsyncResultOwner<");
    expect(ownership).toContain("let r2rTrajectoryPendingAttempt:");
    expect(ownership).toContain("function r2rTrajectorySelectionIsPending()");
    expect(ownership).toContain('r2rTrajectoryState = "idle"');
    expect(ownership).toContain("r2rTrajectoryResults.isLatestResult(commit)");
    expect(ownership).not.toContain(
      "lastAppliedPanelPresentation?.value.r2rPlayback === commit.value",
    );
    expect(ownership).toContain(
      "r2rSrc.isLoadGenerationCurrent(identity.sourceViewGeneration)",
    );

    const runner = runtimeSource.slice(
      runtimeSource.indexOf("async function runR2rTrajectorySelection"),
      runtimeSource.indexOf("function r2rApplySourceTrajectoryResult"),
    );
    const begin = runner.indexOf("beginR2rTrajectorySelection(");
    const firstAwait = runner.indexOf("await ");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(firstAwait);
    expect(runner).toContain('return "superseded"');
    expect(runner).toMatch(/\?\s*"selected"\s*:\s*"superseded"/);
    expect(runner).toContain("if (!isCurrent()) return;");
    expectTokensInOrder(runner, [
      "const data = await spec.load(reportProgress, isCurrent)",
      "if (!data || !isCurrent())",
      "r2rApplySourceTrajectoryResult(",
    ]);
    expectTokensInOrder(runner, [
      "if (!committed)",
      "r2rTrajectoryCommitIsSelected(committed)",
      "publishR2rWorkflowState(() => r2rTrajectoryCommitIsSelected(committed))",
      "r2rTrajectoryCommitIsSelected(committed)",
    ]);
    expect(runner).toContain("void r2rUpdateRetargetBtn().catch(");
    expectTokensInOrder(runner, [
      "} catch (error) {",
      "failR2rTrajectorySelection(trajectoryAttempt, error)",
      'return "superseded"',
    ]);

    const failure = runtimeSource.slice(
      runtimeSource.indexOf("function failR2rTrajectorySelection"),
      runtimeSource.indexOf("async function runR2rTrajectorySelection"),
    );
    expectTokensInOrder(failure, [
      'r2rTrajectoryState = "failed"',
      "toast(errorMessage(error), true)",
      "abandonR2rTrajectorySelection(trajectoryAttempt)",
      "publishR2rWorkflowState(completionIsLatest)",
    ]);
    expectTokensInOrder(runner, [
      'if (!panelSwitchSettledOnStageOwner(panelSwitch, "r2r"))',
      "finishR2rTrajectorySelection(trajectoryAttempt)",
      "publishR2rWorkflowState(completionIsLatest)",
      'return "superseded"',
    ]);

    const apply = runtimeSource.slice(
      runtimeSource.indexOf("function r2rApplySourceTrajectoryResult"),
      runtimeSource.indexOf("async function loadR2rLibraryEntry"),
    );
    expect(apply).toContain("r2rTrajectoryResults.isCurrent(trajectoryAttempt)");
    expect(apply).toContain("r2rSrc.setTrajectory(data.trajectory)");
    expect(apply).toContain(
      "if (!r2rSrcSkel.load(data.skeleton_preview, isCurrent)) {",
    );
    expectTokensInOrder(apply, [
      "r2rLoadSrcScene(",
      "data.scaled_scene",
      "data.token",
      "clipDur",
      "isCurrent",
      ")) return null",
    ]);
    expect(apply).not.toContain("startRobotViewLoad(r2rSrc");
    expect(apply).not.toMatch(/\bplayer\./);
    expect(apply).not.toContain("r2rApplyStage(");
    expect(apply).not.toContain("r2rFocus(");
    const finalApplyGuard = apply.lastIndexOf("if (!isCurrent()) return null");
    const domainCommit = apply.indexOf("commitR2rTrajectorySelection(");
    expect(finalApplyGuard).toBeGreaterThanOrEqual(0);
    expect(domainCommit).toBeGreaterThan(finalApplyGuard);
    expect(apply).not.toContain("publishR2rWorkflowState()");
    expect(apply).not.toContain("r2rUpdateRetargetBtn()");

    const sourceSelection = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rLoadSourceRobot"),
      runtimeSource.indexOf("async function r2rLoadTargetRobot"),
    );
    const sourceSelectionClaim = sourceSelection.indexOf(
      'beginR2rSourceLoad("manual", name)',
    );
    const sourceSelectionAwait = sourceSelection.indexOf(
      'await API.post("/api/robot/select"',
    );
    expect(sourceSelectionClaim).toBeGreaterThanOrEqual(0);
    expect(sourceSelectionClaim).toBeLessThan(sourceSelectionAwait);
    expect(sourceSelection).not.toContain('if (r2rRunState === "running")');
    expect(sourceSelection.indexOf("invalidateR2rRetarget()"))
      .toBeGreaterThan(sourceSelectionClaim);
    expect(sourceSelection.indexOf("invalidateR2rRetarget()"))
      .toBeLessThan(sourceSelectionAwait);
    expectTokensInOrder(sourceSelection, [
      'beginR2rSourceLoad("manual", name)',
      "invalidateR2rRetarget()",
      "invalidateR2rTrajectorySelection()",
      "r2r.sourceToken = null",
      "r2r.sourceStem = null",
      "clearR2rRetargetTransientUi(sourceIsCurrent)",
    ]);
    expect(sourceSelection.match(/invalidateR2rTrajectorySelection\(\)/g))
      .toHaveLength(2);
    expect(sourceSelection.indexOf("invalidateR2rTrajectorySelection()"))
      .toBeLessThan(sourceSelection.indexOf('await API.post("/api/robot/select"'));
    expect(sourceSelection.indexOf("r2r.sourceToken = null"))
      .toBeLessThan(sourceSelection.indexOf('await API.post("/api/robot/select"'));
    expect(sourceSelection.indexOf("r2r.sourceName = null"))
      .toBeLessThan(sourceSelectionAwait);
    expect(sourceSelection.indexOf("r2r.sourcePayload = null"))
      .toBeLessThan(sourceSelectionAwait);
    expect(sourceSelection.indexOf("() => r2rSrc.clear()"))
      .toBeLessThan(sourceSelectionAwait);
    expect(sourceSelection.indexOf("() => r2rApplyStage()"))
      .toBeLessThan(sourceSelectionAwait);
    expectTokensInOrder(sourceSelection, [
      'await API.post("/api/robot/select"',
      "if (!sourceIsCurrent()) return",
      "invalidateR2rTrajectorySelection()",
      "startRobotViewLoad(r2rSrc, sourcePayload)",
      "await viewAttempt.completion",
      'loadResult === "stale"',
      "r2r.sourcePayload = sourcePayload",
    ]);

    const automaticSource = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rEnsureSourceLoaded"),
      runtimeSource.indexOf("function failR2rTrajectorySelection"),
    );
    const automaticSourceClaim = automaticSource.indexOf(
      'beginR2rSourceLoad("trajectory", name)',
    );
    const automaticSourceAwait = automaticSource.indexOf(
      'await API.post("/api/robot/select"',
    );
    expect(automaticSourceClaim).toBeGreaterThanOrEqual(0);
    expect(automaticSourceClaim).toBeLessThan(automaticSourceAwait);
    expect(automaticSource).toContain(
      "trajectoryIsCurrent() && r2rSourceLoadAttempts.isCurrent(sourceAttempt)",
    );
    expectTokensInOrder(automaticSource, [
      'beginR2rSourceLoad("trajectory", name)',
      "() => r2rSrc.clear()",
      'await API.post("/api/robot/select"',
      "if (!sourceIsCurrent()) return superseded()",
      "startRobotViewLoad(r2rSrc, sourcePayload)",
      "await sourceViewAttempt.completion",
      'loadResult === "stale"',
      "r2r.sourcePayload = sourcePayload",
      "finishR2rSourceLoad(sourceAttempt)",
    ]);

    const navigation = runtimeSource.slice(
      runtimeSource.indexOf("interface PanelSwitchReceipt"),
      runtimeSource.indexOf("/** After a robot is loaded"),
    );
    expect(navigation).toContain(
      "pendingR2rPlaybackClaim()?.commit.value ?? null",
    );
    expect(navigation).toContain(
      "markR2rPlaybackPresented(presentedPlayback)",
    );
    expect(navigation).toContain(
      "publishPanelPresentationIntent(operation.value.panelId)",
    );

    const blocked = runtimeSource.slice(
      runtimeSource.indexOf("function r2rBlockedReason"),
      runtimeSource.indexOf("function publishR2rWorkflowState"),
    );
    const pendingGate = blocked.indexOf("r2rTrajectorySelectionIsPending()");
    const validatingGate = blocked.indexOf('r2rTrajectoryState === "validating"');
    const missingTokenGate = blocked.indexOf("!r2r.sourceToken");
    expect(pendingGate).toBeGreaterThanOrEqual(0);
    expect(validatingGate).toBeGreaterThanOrEqual(0);
    expect(missingTokenGate).toBeGreaterThanOrEqual(0);
    expect(pendingGate).toBeLessThan(missingTokenGate);
    expect(validatingGate).toBeLessThan(missingTokenGate);
    const retarget = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rRunRetarget"),
      runtimeSource.indexOf("// --------------------------------------------------------------- batch"),
    );
    const retargetPendingGate = retarget.indexOf("r2rTrajectorySelectionIsPending()");
    const retargetStateGate = retarget.indexOf('r2rTrajectoryState !== "idle"');
    const sourcePendingGate = retarget.indexOf("r2rSourceLoadIsPending()");
    const targetPendingGate = retarget.indexOf("r2rTargetLoadIsPending()");
    const retargetAttempt = retarget.indexOf("beginR2rRetarget(capturedIdentity)");
    const calibrationAwait = retarget.indexOf("await r2rEnsureCalibration");
    expect(retargetPendingGate).toBeGreaterThanOrEqual(0);
    expect(retargetStateGate).toBeGreaterThanOrEqual(0);
    expect(sourcePendingGate).toBeGreaterThanOrEqual(0);
    expect(targetPendingGate).toBeGreaterThanOrEqual(0);
    expect(retargetAttempt).toBeGreaterThanOrEqual(0);
    expect(calibrationAwait).toBeGreaterThanOrEqual(0);
    expect(retargetPendingGate).toBeLessThan(calibrationAwait);
    expect(retargetStateGate).toBeLessThan(calibrationAwait);
    expect(sourcePendingGate).toBeLessThan(retargetAttempt);
    expect(targetPendingGate).toBeLessThan(retargetAttempt);
    expect(retargetAttempt).toBeLessThan(calibrationAwait);
    const retargetClaim = retarget.indexOf('r2rRunState = "running"', calibrationAwait);
    const firstProgressMutation = retarget.indexOf('prog.style.display = "block"');
    expect(retargetClaim).toBeGreaterThan(calibrationAwait);
    expect(firstProgressMutation).toBeGreaterThanOrEqual(0);
    expect(retargetClaim).toBeLessThan(firstProgressMutation);
  });

  it("gives manual R2R target selection exact latest-attempt ownership", () => {
    const ownership = runtimeSource.slice(
      runtimeSource.indexOf("interface R2rTargetLoadIdentity"),
      runtimeSource.indexOf("type R2rTrajectorySelectionKind"),
    );
    expect(ownership).toContain("readonly name: string");
    expect(ownership).toContain(
      "new LatestAsyncAttemptOwner<\n  R2rTargetLoadIdentity",
    );
    expectTokensInOrder(ownership, [
      "function beginR2rTargetLoad(",
      "r2rTargetLoadAttempts.begin(Object.freeze({ name }))",
      "r2rTargetLoadPendingAttempt = attempt",
      "function finishR2rTargetLoad(",
      "r2rTargetLoadAttempts.finish(attempt)",
      "r2rTargetLoadPendingAttempt === attempt",
      "r2rTargetLoadPendingAttempt = null",
    ]);
    expectTokensInOrder(ownership, [
      "function invalidateR2rTargetLoad()",
      "const claimedAttempt = r2rTargetLoadPendingAttempt",
      "r2rTargetLoadAttempts.invalidate()",
      "r2rTargetLoadPendingAttempt === claimedAttempt",
      "r2rTargetLoadPendingAttempt = null",
    ]);
    expect(ownership).toContain(
      "attempt !== null && r2rTargetLoadAttempts.owns(attempt)",
    );

    const selection = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rLoadTargetRobot"),
      runtimeSource.indexOf("// --------------------------------------------------------------- calibration"),
    );
    const claim = selection.indexOf("const targetAttempt = beginR2rTargetLoad(name)");
    const firstAwait = selection.indexOf("await ");
    const request = selection.indexOf('await API.post("/api/robot/select"');
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(firstAwait);
    expect(selection).not.toContain('if (r2rRunState === "running")');
    expectTokensInOrder(selection, [
      "const targetAttempt = beginR2rTargetLoad(name)",
      "r2rTargetLoadAttempts.isCurrent(targetAttempt)",
      "invalidateR2rRetarget()",
      "prepareR2rRobotReplacement()",
      "if (!targetIsCurrent()) return",
      "r2r.targetName = null",
      "r2r.targetPayload = null",
      'await API.post("/api/robot/select"',
      "if (!targetIsCurrent()) return",
      "r2r.targetPayload = targetPayload",
      "r2r.targetName = name",
      "if (!targetIsCurrent()) return",
      "finishR2rTargetLoad(targetAttempt)",
      "await r2rMaybeAutoCalib()",
    ]);
    expect(selection.indexOf("invalidateR2rRetarget()")).toBeLessThan(request);
    for (const effect of [
      "r2rRenderBasket()",
      "publishR2rWorkflowState(completionIsLatest)",
      "toast(runtimeText(",
    ]) {
      const effectAt = selection.indexOf(effect, request);
      const guardedPublication = selection.lastIndexOf(
        "runCurrentBestEffort(",
        effectAt,
      );
      expect(effectAt, `target selection effect: ${effect}`).toBeGreaterThan(request);
      expect(guardedPublication).toBeGreaterThan(request);
      expect(selection.slice(guardedPublication, effectAt)).toContain(
        "completionIsLatest",
      );
    }
    for (const exactEffect of [
      'syncR2rRobotSelects("target", name, completionIsLatest)',
      'setR2rRobotStatus("target", runtimeText(',
    ]) {
      const effectAt = selection.indexOf(exactEffect, request);
      const guardedPublication = selection.lastIndexOf(
        "runCurrentBestEffort(",
        effectAt,
      );
      expect(effectAt, `target exact effect: ${exactEffect}`).toBeGreaterThan(request);
      expect(selection.slice(effectAt, effectAt + 300)).toContain("completionIsLatest");
      expect(guardedPublication).toBeGreaterThan(request);
      expect(selection.slice(guardedPublication, effectAt)).toContain(
        "completionIsLatest",
      );
    }
    const failure = selection.slice(selection.lastIndexOf("} catch (error) {"));
    expectTokensInOrder(failure, [
      "if (!targetIsCurrent()) return",
      "R2R target failure status publication failed",
      "if (!targetIsCurrent()) return",
      "finishR2rTargetLoad(targetAttempt)",
      "R2R target failure workflow publication failed",
      "R2R target failure toast failed",
    ]);

    const blocked = runtimeSource.slice(
      runtimeSource.indexOf("function r2rBlockedReason"),
      runtimeSource.indexOf("function publishR2rWorkflowState"),
    );
    expect(blocked.indexOf("r2rTargetLoadIsPending()"))
      .toBeLessThan(blocked.indexOf("!r2r.targetName"));
    const status = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rUpdateRetargetBtn"),
      runtimeSource.indexOf("// --------------------------------------------------------------- robot pickers"),
    );
    expect(status.indexOf("r2rTargetLoadIsPending()"))
      .toBeLessThan(status.indexOf("await API.get("));
    const calibration = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rStartCalib"),
      runtimeSource.indexOf("function r2rExitCalib"),
    );
    for (const pendingSelection of [
      "r2rTrajectorySelectionIsPending()",
      "r2rSourceLoadIsPending()",
      "r2rTargetLoadIsPending()",
    ]) {
      expect(calibration.indexOf(pendingSelection))
        .toBeLessThan(calibration.indexOf("calibrationPresentationEpoch += 1"));
    }
    const targetLoss = runtimeSource.slice(
      runtimeSource.indexOf("function clearR2rTargetAfterViewLoss"),
      runtimeSource.indexOf("async function r2rLoadSourceRobot"),
    );
    expectTokensInOrder(targetLoss, [
      "invalidateR2rRetarget()",
      "invalidateR2rTargetLoad()",
      "invalidateR2rCalibrationAttempts()",
      "r2r.targetName = null",
      "r2r.targetPayload = null",
    ]);
  });

  it("routes trajectory and retarget playback through one tagged panel claim", () => {
    const navigation = runtimeSource.slice(
      runtimeSource.indexOf("interface PanelSwitchReceipt"),
      runtimeSource.indexOf("/** After a robot is loaded"),
    );
    const claim = navigation.slice(
      navigation.indexOf("type R2rPlaybackClaim"),
      navigation.indexOf("let lastAppliedPanelPresentation"),
    );
    for (const tag of [
      'readonly kind: "trajectory"',
      "readonly commit: R2rTrajectoryPresentationCommit",
      'readonly kind: "retarget"',
      "readonly commit: R2rRetargetPresentationCommit",
    ]) {
      expect(claim).toContain(tag);
    }
    expectTokensInOrder(claim, [
      "const trajectory = r2rTrajectoryResults.pendingPresentation",
      "const retarget = r2rRetargetResults.pendingPresentation",
      "if (Boolean(trajectory) === Boolean(retarget)) return null",
      '? { kind: "trajectory", commit: trajectory }',
      ': { kind: "retarget", commit: retarget! }',
    ]);
    expect(claim).toContain("claim?.commit.value === playback ? claim : null");
    for (const dispatch of [
      "r2rTrajectoryResults.isCommitted(claim.commit)",
      "r2rRetargetResults.isCommitted(claim.commit)",
      "r2rTrajectoryResults.markPresented(claim.commit)",
      "r2rRetargetResults.markPresented(claim.commit)",
    ]) {
      expect(claim).toContain(dispatch);
    }
    expect(navigation).toContain(
      "r2rPlayback: pendingR2rPlaybackClaim()?.commit.value ?? null",
    );
    expect(navigation).toContain(
      "markR2rPlaybackPresented(presentedPlayback)",
    );

    const enter = runtimeSource.slice(
      runtimeSource.indexOf("function r2rEnterPanel"),
      runtimeSource.indexOf("function r2rLeavePanel"),
    );
    expect(enter).toContain("pendingR2rPlaybackClaimFor(playback)");
    expect(enter.match(/r2rPlaybackClaimIsCommitted\(playbackClaim\)/g))
      .toHaveLength(2);
    expect(enter).toContain("return playbackClaim");

    const retargetOwnership = runtimeSource.slice(
      runtimeSource.indexOf("function commitR2rRetarget"),
      runtimeSource.indexOf("interface R2rCalibrationIdentity"),
    );
    expectTokensInOrder(retargetOwnership, [
      "const sourcePresentation = r2rTrajectoryResults.pendingPresentation",
      "r2rRetargetResults.commit(attempt, presentation)",
      "if (!committed) return null",
      "r2rLatestRetargetCommit = committed",
      "r2rTrajectoryResults.withdrawPresentation(sourcePresentation)",
    ]);
    const trajectoryBegin = runtimeSource.slice(
      runtimeSource.indexOf("function beginR2rTrajectorySelection"),
      runtimeSource.indexOf("function finishR2rTrajectorySelection"),
    );
    expectTokensInOrder(trajectoryBegin, [
      "reserveR2rTrajectorySelection(identity)",
      "invalidateR2rRetarget()",
      'clearR2rDerivedTargetAfterViewLoss("R2R trajectory replacement"',
      "clearR2rRetargetTransientUi(",
    ]);
  });

  it("owns each R2R retarget job and freezes every continuation input", () => {
    const ownership = runtimeSource.slice(
      runtimeSource.indexOf("interface R2rRetargetIdentity"),
      runtimeSource.indexOf("interface R2rCalibrationIdentity"),
    );
    for (const identityFact of [
      "readonly sourceName: string",
      "readonly sourcePayload: RobotPayload | null",
      "readonly sourceToken: string",
      "readonly sourceStem: string | null",
      "readonly sourceViewGeneration: number",
      "readonly targetName: string",
      "readonly targetPayload: RobotPayload | null",
      "readonly resolvedTargetPayload: RobotPayload | null",
      "readonly targetViewGeneration: number | null",
      "readonly calibrationRevision: number",
      "readonly calibrationReady: boolean",
      "readonly backend: string",
      "readonly retargetFps: number | null",
    ]) {
      expect(ownership).toContain(identityFact);
    }
    for (const identityCheck of [
      "!r2rSourceLoadIsPending()",
      "!r2rTargetLoadIsPending()",
      "r2r.sourceName === identity.sourceName",
      "r2r.sourcePayload === identity.sourcePayload",
      "r2r.sourceToken === identity.sourceToken",
      "r2r.sourceStem === identity.sourceStem",
      "r2rSrc.isLoadGenerationCurrent(identity.sourceViewGeneration)",
      "r2r.targetName === identity.targetName",
      "r2r.targetPayload === identity.targetPayload",
      "r2r.targetPayload === identity.resolvedTargetPayload",
      "r2rTgt.isLoadGenerationCurrent(identity.targetViewGeneration)",
      "r2rCalibrationRevision === identity.calibrationRevision",
    ]) {
      expect(ownership).toContain(identityCheck);
    }
    expect(ownership).toContain("new LatestAsyncResultOwner<");
    expect(ownership).toContain("let r2rRetargetPendingAttempt:");
    expect(ownership).toContain("let r2rLatestRetargetCommit:");
    expectTokensInOrder(ownership, [
      "function beginR2rRetarget(",
      "r2rRetargetResults.begin(Object.freeze(identity))",
      "r2rRetargetPendingAttempt = attempt",
      "function rebindR2rRetarget(",
      "r2rRetargetResults.isCurrent(attempt)",
      "return beginR2rRetarget(identity)",
      "function finishR2rRetarget(",
      "r2rRetargetResults.finish(attempt)",
      "function commitR2rRetarget(",
      "r2rRetargetResults.commit(attempt, presentation)",
      "function invalidateR2rRetarget()",
      "r2rRetargetResults.invalidate()",
      "r2rRetargetResults.isLatestResult(commit)",
    ]);

    const capture = runtimeSource.slice(
      runtimeSource.indexOf("function captureR2rRetargetIdentity"),
      runtimeSource.indexOf("function failR2rRetarget"),
    );
    expect(capture).toContain("return Object.freeze({");
    for (const captured of [
      "sourceName: r2r.sourceName",
      "sourcePayload: r2r.sourcePayload",
      "sourceToken: r2r.sourceToken",
      "sourceStem: r2r.sourceStem",
      "sourceViewGeneration: r2rSrc.loadGeneration",
      "targetName: r2r.targetName",
      "targetPayload: r2r.targetPayload",
      "targetViewGeneration: r2rTgt.loadGeneration",
      "calibrationRevision: r2rCalibrationRevision",
    ]) {
      expect(capture).toContain(captured);
    }

    const run = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rRunRetarget"),
      runtimeSource.indexOf("// --------------------------------------------------------------- batch"),
    );
    const begin = run.indexOf("beginR2rRetarget(capturedIdentity)");
    const firstAwait = run.indexOf("await ");
    const backendRead = run.indexOf('document.getElementById("r2r-backend")');
    const fpsRead = run.indexOf('document.getElementById("r2r-retarget-fps")');
    const configuredRebind = run.indexOf(
      "const configuredAttempt = rebindR2rRetarget(retargetAttempt",
    );
    const calibrationAwait = run.indexOf("await r2rEnsureCalibration");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(firstAwait);
    expect(begin).toBeLessThan(backendRead);
    expect(backendRead).toBeLessThan(fpsRead);
    expect(run.indexOf("if (!isCurrent()) return", backendRead))
      .toBeLessThan(fpsRead);
    expect(fpsRead).toBeLessThan(configuredRebind);
    expect(configuredRebind).toBeLessThan(calibrationAwait);
    expectTokensInOrder(run, [
      "await r2rEnsureCalibration({",
      "auto: true",
      "retargetAttempt",
      'calibrationResult !== "ready" || !isCurrent()',
      "rebindR2rRetarget(retargetAttempt",
      "calibrationReady: true",
      "retargetAttempt = readyAttempt",
      "if (!isCurrent()) return",
      'r2rRunState = "running"',
    ]);

    const body = run.slice(
      run.indexOf("const body: R2rRetargetRequest"),
      run.indexOf('await API.post("/api/r2r/retarget"'),
    );
    for (const frozenRequestFact of [
      "target: retargetAttempt.identity.targetName",
      "source: retargetAttempt.identity.sourceName",
      "source_token: retargetAttempt.identity.sourceToken",
      "backend: retargetAttempt.identity.backend",
      "body.retarget_fps = retargetAttempt.identity.retargetFps",
    ]) {
      expect(body).toContain(frozenRequestFact);
    }
    expect(body).not.toContain("target: r2r.targetName");
    expect(body).not.toContain("source: r2r.sourceName");
    expect(body).not.toContain('document.getElementById("r2r-backend")');

    expectTokensInOrder(run, [
      'await API.post("/api/r2r/retarget", body)',
      "if (!isCurrent()) return",
      "pollJob<RetargetResult>(job_id, (jp) =>",
      "if (!isCurrent()) return",
      "setRetargetProgress(progressElement, bar, jp, isCurrent)",
      "renderSpinnerStatus(",
      "isCurrent",
      "retargetAttempt.identity.resolvedTargetPayload",
      'name: retargetAttempt.identity.targetName',
      "if (!isCurrent()) return",
      "resolvedTargetPayload: targetPayload",
    ]);
    expectTokensInOrder(run, [
      "targetViewGeneration: null",
      "const targetViewAttempt = startRobotViewLoad(r2rTgt, targetPayload)",
      "if (!isCurrent()) return",
      "targetViewGeneration: targetViewAttempt.generation",
      "await targetViewAttempt.completion",
      'targetLoadResult === "stale"',
      "!isCurrent()",
      "!r2rTgt.isLoadGenerationCurrent(targetViewAttempt.generation)",
      "targetResultStaged = true",
      "prepareR2rRobotReplacement()",
      "if (!isCurrent()) return",
      "r2r.targetPayload = targetPayload",
      "if (!isCurrent()) return",
      "r2rTgt.setTrajectory(j.result.trajectory)",
    ]);

    const completion = run.slice(run.indexOf("const committed = commitR2rRetarget("));
    expectTokensInOrder(completion, [
      "commitR2rRetarget(",
      "Object.freeze({",
      "exportToken: j.result.export_token",
      "exportHasScene: !!j.result.has_scene",
      "resultStem: j.result.stem",
      "if (!committed) return",
      "r2rRetargetCommitIsLatest(committed)",
      "if (!commitIsLatest()) return",
      'emitComparisonState("r2r")',
      "if (!commitIsLatest()) return",
      'emitResultDiagnostics("r2r"',
      "if (!commitIsLatest()) return",
      "publishR2rWorkflowState(commitIsLatest)",
      "if (!commitIsLatest()) return",
      "toast(runtimeText(",
      "if (!commitIsLatest()) return",
      "appliedPanelPresentationOwnsStage({",
      'switchInspectorPanel("r2r")',
    ]);
    for (const preCommitMetadata of [
      "r2r.exportToken = j.result.export_token",
      'r2rRunState = "completed"',
      "r2r.exportHasScene = !!j.result.has_scene",
      "r2r.resultStem = j.result.stem",
      'setR2rComparisonPresetIntent("result")',
    ]) {
      expect(run).not.toContain(preCommitMetadata);
    }
    const atomicCommit = ownership.slice(
      ownership.indexOf("function commitR2rRetarget"),
      ownership.indexOf("function invalidateR2rRetarget"),
    );
    expectTokensInOrder(atomicCommit, [
      "r2rRetargetResults.commit(attempt, presentation)",
      "if (!committed) return null",
      "r2rLatestRetargetCommit = committed",
      "r2r.exportToken = metadata.exportToken",
      'r2rRunState = "completed"',
      "r2r.exportHasScene = metadata.exportHasScene",
      "r2r.resultStem = metadata.resultStem",
      "setR2rComparisonPresetIntent(comparisonPresets.r2r)",
    ]);
    const spinnerRenderer = runtimeSource.slice(
      runtimeSource.indexOf("function renderSpinnerStatus"),
      runtimeSource.indexOf("function renderMetaRows"),
    );
    expect(spinnerRenderer.match(/if \(!isCurrent\(\)\) return false/g)?.length)
      .toBeGreaterThanOrEqual(4);
    expectTokensInOrder(spinnerRenderer, [
      "document.createElement",
      "if (!isCurrent()) return false",
      'spinner.className = "spin"',
      "if (!isCurrent()) return false",
      "document.createTextNode",
      "if (!isCurrent()) return false",
      "container.replaceChildren",
      "return isCurrent()",
    ]);
    const progressRendererStart = runtimeSource.indexOf(
      "function setRetargetProgress",
    );
    const progressRenderer = runtimeSource.slice(
      progressRendererStart,
      runtimeSource.indexOf(
        'document.getElementById("retarget-btn")',
        progressRendererStart,
      ),
    );
    expectTokensInOrder(progressRenderer, [
      "isCurrent: () => boolean",
      "if (!isCurrent()) return false",
      'progressElement.classList.toggle("indet", indet)',
      "if (!isCurrent()) return false",
      "bar.style.width",
      "if (!isCurrent()) return false",
      "return isCurrent()",
    ]);
    // Hidden H2R completion may commit R2R-local state and a pending playback
    // receipt, but only the panel coordinator may touch shared presentation.
    for (const sharedPresentationWrite of [
      "player.ready(",
      "player.seek(",
      "player.setPlaying(",
      "player.refreshFrame(",
      "player.active =",
      "player.t =",
      "player.duration =",
      "_setPlaybarVisible(",
      "revealStage(",
    ]) {
      expect(run).not.toContain(sharedPresentationWrite);
    }
    expect(run).not.toMatch(/\borbit\./);
    expect(run).not.toContain("r2rApplyStage(");
    expect(run).not.toContain("r2rFocus(");
    expect(run).not.toContain("applyR2rComparisonPreset(");
    // Identity validation can fail because a captured RobotView disappeared
    // without any successor request. The token-only finalizer must retire that
    // orphan while remaining neutral to a real newer retarget generation.
    expectTokensInOrder(run, [
      "} finally {",
      "r2rRetargetResults.owns(retargetAttempt)",
      "sourceViewLost",
      "targetViewLost",
      "failR2rRetarget(",
      "abandonR2rRetarget(retargetAttempt)",
      "publishR2rWorkflowState(completionIsLatest)",
    ]);
    expect(run).toContain(
      "if (!r2rTgtSkel.load(j.result.scaled_preview, isCurrent)) {",
    );
    expectTokensInOrder(run, [
      "r2rLoadTgtScene(",
      "j.result.scaled_scene",
      "retargetAttempt.identity.sourceToken",
      "tgtDur",
      "isCurrent",
      ")) return",
    ]);

    const failure = runtimeSource.slice(
      runtimeSource.indexOf("function failR2rRetarget"),
      runtimeSource.indexOf("async function r2rRunRetarget"),
    );
    expectTokensInOrder(failure, [
      "r2rRetargetResults.owns(attempt)",
      "targetResultStaged",
      'clearR2rDerivedTargetAfterViewLoss("R2R retarget failure"',
      "clearR2rRetargetTransientUi(ownsAttempt)",
      'r2rRunState = "failed"',
      "if (!ownsAttempt()) return false",
      "toast(errorMessage(error), true)",
      "if (!ownsAttempt()) return false",
      "abandonR2rRetarget(attempt)",
      "publishR2rWorkflowState(completionIsLatest)",
    ]);
    expect(run.slice(run.lastIndexOf("} catch (e) {"))).toContain(
      "failR2rRetarget(retargetAttempt, e, { targetResultStaged })",
    );
  });

  it("invalidates R2R retarget ownership at every pair-changing intent", () => {
    const boundaries = [
      {
        name: "manual source replacement",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rLoadSourceRobot"),
          runtimeSource.indexOf("async function r2rLoadTargetRobot"),
        ),
        before: 'await API.post("/api/robot/select"',
      },
      {
        name: "manual target replacement",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rLoadTargetRobot"),
          runtimeSource.indexOf("// --------------------------------------------------------------- calibration"),
        ),
        before: 'await API.post("/api/robot/select"',
      },
      {
        name: "calibration replacement",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rStartCalib"),
          runtimeSource.indexOf("function r2rExitCalib"),
        ),
        before: "calibrationPresentationEpoch += 1",
      },
    ] as const;
    for (const boundary of boundaries) {
      const invalidate = boundary.source.indexOf("invalidateR2rRetarget()");
      const cleanup = boundary.source.indexOf(
        "clearR2rRetargetTransientUi",
        invalidate,
      );
      const derivedCleanup = boundary.source.indexOf(
        "clearR2rDerivedTargetAfterViewLoss",
        invalidate,
      );
      const successor = boundary.source.indexOf(boundary.before);
      expect(invalidate, `${boundary.name}: invalidation`).toBeGreaterThanOrEqual(0);
      expect(derivedCleanup, `${boundary.name}: derived cleanup`)
        .toBeGreaterThan(invalidate);
      expect(cleanup, `${boundary.name}: transient cleanup`).toBeGreaterThan(invalidate);
      expect(successor, `${boundary.name}: successor boundary`).toBeGreaterThan(invalidate);
      expect(derivedCleanup, `${boundary.name}: derived cleanup order`)
        .toBeLessThan(successor);
      expect(cleanup, `${boundary.name}: cleanup order`).toBeLessThan(successor);
    }

    const trajectoryReplacement = runtimeSource.slice(
      runtimeSource.indexOf("function beginR2rTrajectorySelection"),
      runtimeSource.indexOf("function finishR2rTrajectorySelection"),
    );
    expectTokensInOrder(trajectoryReplacement, [
      "reserveR2rTrajectorySelection(identity)",
      "invalidateR2rRetarget()",
      'clearR2rDerivedTargetAfterViewLoss("R2R trajectory replacement"',
      "clearR2rRetargetTransientUi(",
    ]);
    const trajectoryReservation = runtimeSource.slice(
      runtimeSource.indexOf("function reserveR2rTrajectorySelection"),
      runtimeSource.indexOf("function beginR2rTrajectorySelection"),
    );
    expectTokensInOrder(trajectoryReservation, [
      "r2rTrajectoryResults.begin(identity)",
      "r2rTrajectoryPendingAttempt = attempt",
      "return attempt",
    ]);
    const trajectoryRebind = runtimeSource.slice(
      runtimeSource.indexOf("function rebindR2rTrajectorySelection"),
      runtimeSource.indexOf("/** Immutable capabilities and request options"),
    );
    expect(trajectoryRebind).toContain("reserveR2rTrajectorySelection(");
    expect(trajectoryRebind).not.toContain("beginR2rTrajectorySelection(");
    expect(trajectoryRebind).not.toContain("clearR2rDerivedTargetAfterViewLoss(");
    expect(trajectoryRebind).not.toContain("clearR2rRetargetTransientUi(");

    const status = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rUpdateRetargetBtn"),
      runtimeSource.indexOf("// --------------------------------------------------------------- robot pickers"),
    );
    expect(status).toContain("r2r.calibrated = calibrated");
    expect(status).not.toContain("invalidateR2rRetarget()");
    expect(status).toContain(": !r2rRetargetIsPending()");

    const transientCleanup = runtimeSource.slice(
      runtimeSource.indexOf("function clearR2rRetargetTransientUi"),
      runtimeSource.indexOf("function r2rBlockedReason"),
    );
    expectTokensInOrder(transientCleanup, [
      "if (!isCurrent()) return false",
      "readBestEffort(",
      '"R2R retarget progress lookup failed"',
      'document.getElementById("r2r-progress")',
      "if (!isCurrent()) return false",
      'currentProgress.classList.remove("indet")',
      "if (!isCurrent()) return false",
      'currentProgress.style.display = "none"',
      "if (!isCurrent()) return false",
      'currentBar.style.width = "0%"',
      "if (!isCurrent()) return false",
      'document.getElementById("r2r-status")',
      "if (!isCurrent()) return false",
      'currentStatus.textContent = ""',
      "return isCurrent()",
    ]);
    const retargetRun = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rRunRetarget"),
      runtimeSource.indexOf("// --------------------------------------------------------------- batch"),
    );
    expectTokensInOrder(retargetRun, [
      "beginR2rRetarget(capturedIdentity)",
      'r2rRunState = "idle"',
      'clearR2rDerivedTargetAfterViewLoss("R2R retarget replacement"',
      "clearR2rRetargetTransientUi(isCurrent)",
      'document.getElementById("r2r-backend")',
    ]);
    const autoCalibration = runtimeSource.slice(
      runtimeSource.indexOf("async function r2rMaybeAutoCalib"),
      runtimeSource.indexOf("async function r2rSaveCalib"),
    );
    expect(autoCalibration).toContain("|| r2rRetargetIsPending()");
    for (const lossFunction of [
      "clearR2rSourceAfterViewLoss",
      "clearR2rTargetAfterViewLoss",
    ]) {
      const start = runtimeSource.indexOf(`function ${lossFunction}`);
      const body = runtimeSource.slice(start, runtimeSource.indexOf("\n}", start) + 2);
      expect(body).toContain("invalidateR2rRetarget()");
    }
    const invalidation = runtimeSource.slice(
      runtimeSource.indexOf("function invalidateR2rRetarget"),
      runtimeSource.indexOf("function r2rRetargetCommitIsLatest"),
    );
    expect(invalidation).not.toContain("invalidateR2rTrajectorySelection()");
    for (const withdrawnResultFact of [
      "r2r.exportToken = null",
      "r2r.exportHasScene = false",
      "r2r.resultStem = null",
      'r2rRunState = "idle"',
    ]) {
      expect(invalidation).toContain(withdrawnResultFact);
    }
  });

  it("invalidates scaled previews when their H2R identity changes", () => {
    const referenceChange = runtimeSource.slice(
      runtimeSource.indexOf("async function onReferenceChange"),
      runtimeSource.indexOf("function updatePills"),
    );
    const motionSelectionPreparation = runtimeSource.slice(
      runtimeSource.indexOf("function prepareH2rMotionSelection"),
      runtimeSource.indexOf("function finishH2rMotionSelection"),
    );
    const robotLoad = runtimeSource.slice(
      runtimeSource.indexOf("async function applyRobot"),
      runtimeSource.indexOf("async function loadRobotSummary"),
    );
    const robotDelete = runtimeSource.slice(
      runtimeSource.indexOf("async function deleteRobotSummary"),
      runtimeSource.indexOf("const robotSearchInput"),
    );

    for (const identityCommit of [referenceChange, robotLoad]) {
      expect(identityCommit).toContain("clearH2rScaledPreview()");
    }
    expect(motionSelectionPreparation).toContain(
      "clearH2rScaledPreview(ownsPairMutation)",
    );
    expect(robotDelete).toContain(
      'clearH2rRobotAfterViewLoss("deleted robot")',
    );
    const robotLossCleanup = runtimeSource.slice(
      runtimeSource.indexOf("function clearH2rRobotAfterViewLoss"),
      runtimeSource.indexOf("async function refreshScaledPreview"),
    );
    expect(robotLossCleanup).toContain("clearH2rScaledPreview()");
  });

  it("commits async retarget results only after the final identity guard", () => {
    const retarget = runtimeSource.slice(
      runtimeSource.indexOf('document.getElementById("retarget-btn").onclick'),
      runtimeSource.indexOf("function csvHeaderEnabled"),
    );
    const finalGuard = retarget.lastIndexOf("if (discardStaleResult()) return");
    const trajectoryCommit = retarget.indexOf(
      "state.robotTrajectory = candidateTrajectory",
    );

    expect(finalGuard).toBeGreaterThanOrEqual(0);
    expect(trajectoryCommit).toBeGreaterThan(finalGuard);
    expectTokensInOrder(retarget.slice(finalGuard), [
      "candidateTrajectory = j.result.trajectory",
      "trajectoryMutationStarted = true",
      "robot.setTrajectory(candidateTrajectory)",
      "state.robotTrajectory = candidateTrajectory",
      "state.exportToken = j.result.export_token",
      'h2rRunState = "completed"',
      "pendingH2rPlayback = Object.freeze({",
      "resultCommitted = true",
      "withH2rStageDisplayBatch(() =>",
      'emitResultDiagnostics("h2r"',
      "presentPendingH2rPlayback()",
    ]);
    expect(retarget).toContain("if (resultCommitted)");
    expect(retarget).toContain("const retargetOwnsRun = (): boolean");
    expect(retarget).toContain("const retargetMayPublish = (): boolean");
    const rawRunOwner = retarget.slice(
      retarget.indexOf("const retargetOwnsRun = (): boolean"),
      retarget.indexOf("const retargetMayPublish = (): boolean"),
    );
    expect(rawRunOwner).toContain(
      "retargetRevision === h2rRetargetRevision",
    );
    expect(rawRunOwner).not.toContain("h2rMotionInputRevision");
    expect(rawRunOwner).not.toContain("h2rScaledPairRevision");
    const retargetFinally = retarget.slice(retarget.indexOf("} finally {"));
    expect(retargetFinally).toContain(
      'if (retargetOwnsRun() && h2rRunState === "running")',
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
        start: "const viewAttempt = startRobotViewLoad(robot, robotData)",
        load: "const loadResult = await viewAttempt.completion",
        staleCheck: 'loadResult === "stale"',
        generationCheck:
          "!robot.isLoadGenerationCurrent(viewAttempt.generation)",
        commit: "state.robot = robotData",
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
        start: "const viewAttempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        load: "loadResult = await viewAttempt.completion",
        staleCheck: 'loadResult === "stale"',
        generationCheck:
          "!r2rSrc.isLoadGenerationCurrent(viewAttempt.generation)",
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
        generationCheck: "!manipulatorOwnsLease()",
        commit: "r2rTgt.groundOffset =",
      },
      {
        name: "R2R automatic source",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rEnsureSourceLoaded"),
          runtimeSource.indexOf("function failR2rTrajectorySelection"),
        ),
        start: "const sourceViewAttempt = startRobotViewLoad(r2rSrc, sourcePayload)",
        load: "const loadResult = await sourceViewAttempt.completion",
        staleCheck: 'loadResult === "stale"',
        generationCheck: "!sourceIsCurrent()",
        commit: "r2r.sourcePayload = sourcePayload",
      },
      {
        name: "R2R retarget result",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rRunRetarget"),
          runtimeSource.indexOf("// --------------------------------------------------------------- batch"),
        ),
        start: "const targetViewAttempt = startRobotViewLoad(r2rTgt, targetPayload)",
        load: "targetLoadResult = await targetViewAttempt.completion",
        staleCheck: 'targetLoadResult === "stale"',
        generationCheck:
          "!r2rTgt.isLoadGenerationCurrent(targetViewAttempt.generation)",
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
    expect(runtimeSource).toContain("robot.claimLoadGeneration()");
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
    expect(h2rCleanup).toContain("calibManip.stop(manipulatorSession)");
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
      "r2rSrcSkel.clear(isCurrent)",
      "r2rSrcEnv.clear(isCurrent)",
      "r2rTgtSkel.clear(isCurrent)",
      "r2rTgtEnv.clear(isCurrent)",
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
          'if (!robot.isLoadGenerationCurrent(viewAttempt.generation)) return "stale"',
        cleanup: "projectRobotCapabilityWithdrawal(",
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
          "|| !r2rSrc.isLoadGenerationCurrent(viewAttempt.generation)",
        cleanup: "failOwnedSourceLoad(error)",
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
        name: "R2R retarget target",
        source: runtimeSource.slice(
          runtimeSource.indexOf("async function r2rRunRetarget"),
          runtimeSource.indexOf("// --------------------------------------------------------------- batch"),
        ),
        generationGuard:
          "!r2rTgt.isLoadGenerationCurrent(targetViewAttempt.generation)",
        cleanup: "clearR2rDerivedTargetAfterViewLoss(",
      },
    ] as const;
    const r2rSourceSelection = currentFailureCallers[2].source;
    const sourceFailureHelperStart = r2rSourceSelection.indexOf(
      "const failOwnedSourceLoad",
    );
    const sourceFailureHelperEnd = r2rSourceSelection.indexOf(
      "\n  try {",
      sourceFailureHelperStart,
    );
    expect(sourceFailureHelperStart).toBeGreaterThanOrEqual(0);
    expect(sourceFailureHelperEnd).toBeGreaterThan(sourceFailureHelperStart);
    const sourceFailureHelper = r2rSourceSelection.slice(
      sourceFailureHelperStart,
      sourceFailureHelperEnd,
    );
    expect(sourceFailureHelper).toContain(
      'clearR2rSourceAfterViewLoss(\n      "selected R2R source load"',
    );
    for (const caller of currentFailureCallers) {
      const guard = caller.source.indexOf(caller.generationGuard);
      const cleanup = caller.source.indexOf(caller.cleanup, guard);
      expect(guard, `${caller.name}: generation guard`).toBeGreaterThanOrEqual(0);
      expect(cleanup, `${caller.name}: failure cleanup`).toBeGreaterThan(guard);
    }
  });
});
