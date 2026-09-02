import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserLegacyStageStateAdapter } from "../../src/workbench/services/stage/browser/browser-legacy-stage-state-adapter";
import { StageModel } from "../../src/workbench/services/stage/common/stage-model";
import { getStagePlaybackProgress } from "../../src/workbench/services/stage/common/stage-service";

const ownedAdapters: BrowserLegacyStageStateAdapter[] = [];
const ownedModels: StageModel[] = [];

function createHarness() {
  const model = new StageModel(vi.fn());
  const adapter = new BrowserLegacyStageStateAdapter(model);
  ownedAdapters.push(adapter);
  ownedModels.push(model);
  return { adapter, model };
}

function publishPlayback(
  detail: WindowEventMap["hhtools:playback-state"]["detail"],
): void {
  window.dispatchEvent(
    new CustomEvent("hhtools:playback-state", { detail }),
  );
}

afterEach(() => {
  for (const adapter of ownedAdapters.splice(0)) adapter.dispose();
  for (const model of ownedModels.splice(0)) model.dispose();
});

describe("BrowserLegacyStageStateAdapter", () => {
  it("projects a complete legacy playback event into semantic Stage state", () => {
    const { model } = createHarness();
    const listener = vi.fn();
    model.onDidChangeState(listener);

    publishPlayback({
      visible: true,
      active: true,
      playing: true,
      loop: false,
      currentTime: 2,
      duration: 8,
      sourceDuration: 12,
      progress: 0.25,
      speed: 1.5,
      label: "2.00 / 8.00 s (preview; source 12.0 s)",
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(model.state.playback).toEqual({
      controlsVisible: true,
      active: true,
      playing: true,
      loop: false,
      currentTime: 2,
      duration: 8,
      sourceDuration: 12,
      speed: 1.5,
    });
    expect(getStagePlaybackProgress(model.state.playback)).toBe(0.25);
  });

  it("preserves omitted fields and ignores legacy presentation-only values", () => {
    const { model } = createHarness();
    model.updateState({
      playback: {
        active: true,
        playing: true,
        currentTime: 3,
        duration: 6,
        sourceDuration: 9,
      },
    });
    const listener = vi.fn();
    model.onDidChangeState(listener);

    publishPlayback({ label: "presentation only", progress: 0.9 });

    expect(listener).not.toHaveBeenCalled();
    expect(model.state.playback).toMatchObject({
      active: true,
      playing: true,
      currentTime: 3,
      duration: 6,
      sourceDuration: 9,
    });
  });

  it("forwards explicit null when preview metadata is cleared", () => {
    const { model } = createHarness();
    model.updateState({ playback: { sourceDuration: 12 } });

    publishPlayback({ sourceDuration: null });

    expect(model.state.playback.sourceDuration).toBeNull();
  });

  it("stops projecting after idempotent disposal", () => {
    const { adapter, model } = createHarness();
    adapter.dispose();
    adapter.dispose();

    publishPlayback({ visible: true });

    expect(model.state.playback.controlsVisible).toBe(false);
  });
});
