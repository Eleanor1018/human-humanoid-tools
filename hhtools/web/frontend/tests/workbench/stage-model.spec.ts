import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { StageModel } from "../../src/workbench/services/stage/common/stage-model";
import {
  STAGE_LAYER_IDS,
  getStagePlaybackProgress,
  type IStageModelService,
} from "../../src/workbench/services/stage/common/stage-service";

function createModel() {
  const reportError = vi.fn();
  return { model: new StageModel(reportError), reportError };
}

describe("StageModel", () => {
  it("exposes a read-only service contract to Views", () => {
    expectTypeOf<IStageModelService>().not.toHaveProperty("updateState");
  });

  it("starts with a complete deeply frozen semantic snapshot", () => {
    const { model } = createModel();

    expect(model.state).toMatchObject({
      motionIdentity: null,
      robotIdentity: null,
      playback: {
        controlsVisible: false,
        active: false,
        playing: false,
        loop: true,
        currentTime: 0,
        duration: 0,
        previewSourceDuration: null,
        speed: 1,
      },
      display: { empty: true, canResetView: false },
    });
    expect(Object.keys(model.state.display.layers)).toEqual(STAGE_LAYER_IDS);
    expect(
      Object.values(model.state.display.layers).every(
        (layer) => !layer.available && !layer.visible,
      ),
    ).toBe(true);
    expect(Object.isFrozen(model.state)).toBe(true);
    expect(Object.isFrozen(model.state.playback)).toBe(true);
    expect(Object.isFrozen(model.state.display)).toBe(true);
    expect(Object.isFrozen(model.state.display.layers)).toBe(true);
    expect(
      Object.values(model.state.display.layers).every(Object.isFrozen),
    ).toBe(true);
  });

  it("commits one atomic snapshot and leaves prior snapshots untouched", () => {
    const { model } = createModel();
    const previous = model.state;
    const snapshots = vi.fn();
    const motionIdentity = { id: "walk-token", label: "Walk" };
    model.onDidChangeState(snapshots);

    model.updateState({
      motionIdentity,
      robotIdentity: { id: "g1", label: "Unitree G1" },
      playback: {
        controlsVisible: true,
        active: true,
        playing: true,
        currentTime: 2,
        duration: 8,
        previewSourceDuration: 12,
      },
      display: {
        empty: false,
        canResetView: true,
        layers: {
          sourceSkeleton: { available: true, visible: true },
          resultRobot: { available: true, visible: true },
        },
      },
    });

    expect(snapshots).toHaveBeenCalledOnce();
    expect(snapshots).toHaveBeenCalledWith(model.state);
    expect(model.state).toMatchObject({
      motionIdentity: { id: "walk-token", label: "Walk" },
      robotIdentity: { id: "g1", label: "Unitree G1" },
      playback: {
        controlsVisible: true,
        active: true,
        playing: true,
        currentTime: 2,
        duration: 8,
        previewSourceDuration: 12,
      },
      display: {
        empty: false,
        canResetView: true,
        layers: {
          sourceSkeleton: { available: true, visible: true },
          resultRobot: { available: true, visible: true },
        },
      },
    });
    expect(getStagePlaybackProgress(model.state.playback)).toBe(0.25);
    motionIdentity.label = "Changed outside the model";
    expect(model.state.motionIdentity?.label).toBe("Walk");
    expect(Object.isFrozen(model.state.motionIdentity)).toBe(true);
    expect(previous.motionIdentity).toBeNull();
    expect(previous.playback.active).toBe(false);
    expect(previous.display.empty).toBe(true);
  });

  it("can explicitly clear nullable preview duration metadata", () => {
    const { model } = createModel();
    model.updateState({ playback: { previewSourceDuration: 12 } });

    model.updateState({ playback: { previewSourceDuration: null } });

    expect(model.state.playback.previewSourceDuration).toBeNull();
  });

  it("treats explicit undefined like an omitted optional update", () => {
    const { model } = createModel();
    const listener = vi.fn();
    model.updateState({
      motionIdentity: { id: "motion-1", label: "Walk" },
      robotIdentity: { id: "robot-1", label: "G1" },
      playback: { previewSourceDuration: 12 },
    });
    model.onDidChangeState(listener);

    model.updateState({
      motionIdentity: undefined,
      robotIdentity: undefined,
      playback: { previewSourceDuration: undefined },
    });

    expect(listener).not.toHaveBeenCalled();
    expect(model.state.motionIdentity?.id).toBe("motion-1");
    expect(model.state.robotIdentity?.id).toBe("robot-1");
    expect(model.state.playback.previewSourceDuration).toBe(12);
  });

  it("normalizes playback values and semantic display invariants", () => {
    const { model } = createModel();

    model.updateState({
      playback: {
        active: false,
        playing: true,
        currentTime: 20,
        duration: 5,
        previewSourceDuration: -2,
        speed: Number.POSITIVE_INFINITY,
      },
      display: {
        empty: true,
        canResetView: true,
        layers: {
          sourceEnvironment: { available: false, visible: true },
        },
      },
    });

    expect(model.state.playback).toMatchObject({
      active: false,
      playing: false,
      currentTime: 5,
      duration: 5,
      previewSourceDuration: 0,
      speed: 1,
    });
    expect(model.state.display.canResetView).toBe(false);
    expect(model.state.display.layers.sourceEnvironment).toEqual({
      available: false,
      visible: false,
    });
  });

  it("deduplicates semantic no-ops, including equivalent identities", () => {
    const { model } = createModel();
    const listener = vi.fn();
    model.onDidChangeState(listener);

    model.updateState({});
    model.updateState({ playback: { speed: 1 } });
    model.updateState({
      display: {
        layers: { sourceSkeleton: { available: false, visible: true } },
      },
    });
    expect(listener).not.toHaveBeenCalled();

    model.updateState({ motionIdentity: { id: "motion-1", label: "Walk" } });
    model.updateState({ motionIdentity: { id: "motion-1", label: "Walk" } });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("updates several layers in one event and hides unavailable layers", () => {
    const { model } = createModel();
    const listener = vi.fn();
    model.onDidChangeState(listener);

    model.updateState({
      display: {
        empty: false,
        layers: {
          sourceSkeleton: { available: true, visible: true },
          sourceBody: { available: true, visible: true },
          resultRobot: { available: true, visible: true },
        },
      },
    });
    model.updateState({
      display: {
        layers: {
          sourceSkeleton: { available: false },
          sourceBody: { visible: false },
        },
      },
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(model.state.display.layers).toMatchObject({
      sourceSkeleton: { available: false, visible: false },
      sourceBody: { available: true, visible: false },
      resultRobot: { available: true, visible: true },
    });
  });

  it("isolates observer and reporter failures after committing state", () => {
    const failure = new Error("observer failed");
    const reportError = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const model = new StageModel(reportError);
    const sibling = vi.fn();
    model.onDidChangeState(() => {
      throw failure;
    });
    model.onDidChangeState(sibling);

    expect(() =>
      model.updateState({ playback: { controlsVisible: true } }),
    ).not.toThrow();
    expect(sibling).toHaveBeenCalledWith(model.state);
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(model.state.playback.controlsVisible).toBe(true);
  });

  it("disposes idempotently and rejects later mutation", () => {
    const { model } = createModel();
    const listener = vi.fn();
    model.onDidChangeState(listener);

    model.dispose();
    model.dispose();

    expect(() =>
      model.updateState({ playback: { controlsVisible: true } }),
    ).toThrow("StageModel has been disposed");
    expect(listener).not.toHaveBeenCalled();
  });
});
