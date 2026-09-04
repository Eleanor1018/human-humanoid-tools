import { describe, expect, it } from "vitest";

import { BrowserLegacyStagePlaybackCommands } from "../../src/workbench/services/stage/browser/browser-legacy-stage-playback-commands";

function createHarness() {
  const target = new EventTarget();
  const received: unknown[] = [];
  target.addEventListener("hhtools:playback-command", (event) => {
    received.push((event as CustomEvent).detail);
  });
  return {
    commands: new BrowserLegacyStagePlaybackCommands(target),
    received,
  };
}

describe("BrowserLegacyStagePlaybackCommands", () => {
  it("translates semantic methods into compatibility player commands", () => {
    const { commands, received } = createHarness();

    commands.togglePlayback();
    commands.seekToFraction(0.25);
    commands.setPlaybackSpeed(1.5);
    commands.togglePlaybackLoop();

    expect(received).toEqual([
      { action: "toggle", value: undefined },
      { action: "seek", value: 0.25 },
      { action: "speed", value: 1.5 },
      { action: "loop", value: undefined },
    ]);
  });

  it("normalizes invalid values before they cross the legacy boundary", () => {
    const { commands, received } = createHarness();

    commands.seekToFraction(-1);
    commands.seekToFraction(2);
    commands.seekToFraction(Number.NaN);
    commands.setPlaybackSpeed(0);
    commands.setPlaybackSpeed(10);
    commands.setPlaybackSpeed(Number.POSITIVE_INFINITY);

    expect(received).toEqual([
      { action: "seek", value: 0 },
      { action: "seek", value: 1 },
      { action: "seek", value: 0 },
      { action: "speed", value: 0.1 },
      { action: "speed", value: 4 },
      { action: "speed", value: 1 },
    ]);
  });
});
