import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedProgress,
  canSetupGvhmrInDesktop,
  getGvhmrRuntimeStatus,
  isSupportedVideoName,
  parseOptionalFocalLength,
  setupGvhmrInDesktop,
  startVideoToMotion,
  summarizeMotionResult,
  waitForVideoToMotion,
} from "../src/features/video-to-motion/api.ts";

test("uses the desktop setup bridge only when Electron exposes it", async () => {
  const webHost = {};
  const desktopHost = {
    hhtoolsDesktop: {
      setupGvhmr: async () => ({ action: "configured" as const }),
    },
  };
  assert.equal(canSetupGvhmrInDesktop(webHost), false);
  assert.equal(canSetupGvhmrInDesktop(desktopHost), true);
  assert.deepEqual(await setupGvhmrInDesktop(desktopHost), {
    action: "configured",
  });
});

test("validates video names and optional focal length", () => {
  assert.equal(isSupportedVideoName("walk.MP4"), true);
  assert.equal(isSupportedVideoName("walk.txt"), false);
  assert.equal(parseOptionalFocalLength(""), undefined);
  assert.equal(parseOptionalFocalLength(" 35 "), 35);
  assert.throws(() => parseOptionalFocalLength("1.5"), /positive integer/);
  assert.throws(() => parseOptionalFocalLength("0"), /positive integer/);
});

test("normalizes runtime status responses", async () => {
  const status = await getGvhmrRuntimeStatus(
    new AbortController().signal,
    async () => Response.json({ ready: true, missing: ["valid", 42] }),
  );
  assert.deepEqual(status.missing, ["valid"]);
  assert.equal(status.ready, true);
});

test("starts the official-weight upload contract", async () => {
  let requestedUrl = "";
  let requestedBody: FormData | null = null;
  const video = new File(["video"], "turn.mov", { type: "video/quicktime" });
  const jobId = await startVideoToMotion(
    { video, staticCamera: false, focalLength: 50 },
    new AbortController().signal,
    async (input, init) => {
      requestedUrl = String(input);
      requestedBody = init?.body as FormData;
      return Response.json({ job_id: "job-123" });
    },
  );
  assert.equal(jobId, "job-123");
  assert.equal(requestedUrl, "/api/video-to-motion/upload?static_cam=false&f_mm=50");
  assert.deepEqual([...requestedBody!.keys()], ["files"]);
  assert.equal(requestedBody!.has("checkpoint"), false);
});

test("polls progress and returns the completed motion", async () => {
  const updates: number[] = [];
  const responses = [
    { id: "job-1", kind: "video_to_motion", status: "running", progress: 1.4 },
    {
      id: "job-1",
      kind: "video_to_motion",
      status: "done",
      progress: 1,
      result: { name: "motion", token: "motion-token" },
    },
  ];
  const result = await waitForVideoToMotion(
    "job-1",
    {
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      onUpdate: (job) => updates.push(job.progress),
    },
    async () => Response.json(responses.shift()),
  );
  assert.deepEqual(updates, [1, 1]);
  assert.equal(result.token, "motion-token");
});

test("summarizes total frames without retaining frame arrays", () => {
  assert.equal(boundedProgress(-1), 0);
  assert.deepEqual(
    summarizeMotionResult(
      {
        positions: [[], [], []],
        playback_frames: 3,
        num_frames_total: 3_000,
        duration: 100,
        sample_rate: 30,
        linked_folder: "gvhmr-turn",
      },
      "turn.mov",
    ),
    {
      name: "turn.mov",
      token: null,
      frames: 3_000,
      duration: 100,
      framerate: 30,
      linkedFolder: "gvhmr-turn",
    },
  );
});
