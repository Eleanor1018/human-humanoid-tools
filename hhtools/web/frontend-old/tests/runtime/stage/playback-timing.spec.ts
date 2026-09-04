import { describe, expect, it } from "vitest";

import {
  effectivePlaybackDuration,
  resolvePlaybackFrame,
} from "../../../src/runtime/stage/playback-timing";

describe("playback timing", () => {
  it("spans sparse preview frames across the full source duration", () => {
    expect(effectivePlaybackDuration({
      playback_frames: 10,
      num_frames_total: 301,
      framerate: 30,
    })).toBe(10);
    expect(effectivePlaybackDuration({
      playback_duration: 4.5,
      num_frames_total: 301,
      framerate: 30,
    })).toBe(4.5);
  });

  it("interpolates adjacent frames but snaps across sparse source gaps", () => {
    expect(resolvePlaybackFrame([0, 1], 0.25, 1)).toEqual({
      ia: 0,
      ib: 1,
      t: 0.25,
    });
    expect(resolvePlaybackFrame([0, 10], 0.49, 1)).toEqual({
      ia: 0,
      ib: 0,
      t: 0,
    });
    expect(resolvePlaybackFrame([0, 10], 0.5, 1)).toEqual({
      ia: 1,
      ib: 1,
      t: 0,
    });
  });
});
