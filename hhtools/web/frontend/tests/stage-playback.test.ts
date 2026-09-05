import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  createBodyMeshResource,
  disposeBodyMesh,
  setBodyMeshFrame,
  type CompleteBodyMeshPayload,
} from "../src/stage/bodyMesh.ts";
import { frameAtTime, motionDuration } from "../src/stage/playback.ts";
import type { StageMotionPayload } from "../src/stage/types.ts";

function motion(overrides: Partial<StageMotionPayload> = {}): StageMotionPayload {
  return {
    positions: [
      [[0, 0, 0]],
      [[1, 0, 0]],
      [[2, 0, 0]],
      [[3, 0, 0]],
      [[4, 0, 0]],
    ],
    parent_indices: [-1],
    playback_duration: 2,
    ...overrides,
  };
}

test("maps elapsed time onto the full serialized motion timeline", () => {
  const payload = motion();
  assert.equal(motionDuration(payload), 2);
  assert.equal(frameAtTime(payload, 0), 0);
  assert.equal(frameAtTime(payload, 1), 2);
  assert.equal(frameAtTime(payload, 2.5), 1);
  assert.equal(
    motionDuration(motion({ playback_duration: Number.NaN, duration: 3 })),
    3,
  );

  assert.equal(
    motionDuration(
      motion({ playback_duration: undefined, duration: undefined, num_frames_total: 61, framerate: 30 }),
    ),
    2,
  );
});

test("decodes and interpolates the backend baked-body layout", async () => {
  const vertices = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 2,
    1, 0, 2,
    0, 1, 2,
  ]);
  const compressed = gzipSync(Buffer.from(vertices.buffer));
  const payload: CompleteBodyMeshPayload = {
    available: true,
    vertices_gz_b64: compressed.toString("base64"),
    num_verts: 3,
    num_frames: 2,
    triangles: [[0, 1, 2]],
  };

  const resource = await createBodyMeshResource(payload);
  try {
    setBodyMeshFrame(resource, 0.5);
    const positions = resource.mesh.geometry.getAttribute("position").array;
    assert.deepEqual(Array.from(positions), [
      0, 0, 1,
      1, 0, 1,
      0, 1, 1,
    ]);
  } finally {
    disposeBodyMesh(resource);
  }
});
