import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  createBodyMeshResource,
  disposeBodyMesh,
  setBodyMeshFrame,
  type CompleteBodyMeshPayload,
} from "../src/stage/bodyMesh.ts";
import {
  createCapsuleBodyResource,
  disposeCapsuleBody,
  setCapsuleBodyFrame,
} from "../src/stage/capsuleBody.ts";
import {
  frameAtTime,
  motionDuration,
  timelineDuration,
  timelineFrameAtTime,
} from "../src/stage/playback.ts";
import { defaultStageLayers } from "../src/stage/presentation.ts";
import type {
  StageMotionPayload,
  StageRobotTrajectoryPayload,
} from "../src/stage/types.ts";
import {
  BAKED_BODY_VISUAL,
  CAPSULE_BODY_VISUAL,
  ENVIRONMENT_VISUALS,
  ROBOT_VISUAL,
  SKELETON_VISUALS,
} from "../src/stage/visualStyle.ts";

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
  assert.equal(frameAtTime(payload, 2.5), 4);
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

test("maps elapsed time onto serialized robot trajectory frames", () => {
  const trajectory: StageRobotTrajectoryPayload = {
    frames: [{ links: {} }, { links: {} }, { links: {} }],
    sample_rate: 2,
  };
  assert.equal(timelineDuration(trajectory), 1);
  assert.equal(timelineFrameAtTime(trajectory, 0.5), 1);
  assert.equal(timelineFrameAtTime(trajectory, 2), 2);
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

test("builds and animates the legacy capsule body for any skeleton", () => {
  const payload = motion({
    positions: [
      [[0, 0, 0], [0, 0, 1]],
      [[1, 0, 0], [1, 0, 1]],
    ],
    parent_indices: [-1, 0],
  });
  const resource = createCapsuleBodyResource(payload);
  assert.ok(resource);
  try {
    assert.equal(resource.mesh.material.color.getHex(), 0xf7a470);
    assert.equal(resource.mesh.geometry.getAttribute("position").count, 36);
    assert.equal(resource.mesh.geometry.getIndex()?.count, 156);
    const before = resource.positions[0];
    setCapsuleBodyFrame(resource, payload, 1);
    assert.equal(resource.positions[0], before + 1);
  } finally {
    disposeCapsuleBody(resource);
  }
});

test("capsule body does not interpolate across sparse source frames", () => {
  const payload = motion({
    positions: [
      [[0, 0, 0], [0, 0, 1]],
      [[10, 0, 0], [10, 0, 1]],
    ],
    parent_indices: [-1, 0],
    frame_indices: [0, 20],
  });
  const resource = createCapsuleBodyResource(payload);
  assert.ok(resource);
  try {
    const first = resource.positions[0];
    setCapsuleBodyFrame(resource, payload, 0.25);
    assert.equal(resource.positions[0], first);
    setCapsuleBodyFrame(resource, payload, 0.75);
    assert.equal(resource.positions[0], first + 10);
  } finally {
    disposeCapsuleBody(resource);
  }
});

test("keeps the original source and scaled Stage palette distinct", () => {
  assert.equal(SKELETON_VISUALS.source.color, 0x0a84ff);
  assert.equal(SKELETON_VISUALS.scaled.color, 0xffb020);
  assert.equal(SKELETON_VISUALS.reference.color, 0x5eb3ff);
  assert.equal(CAPSULE_BODY_VISUAL.color, 0xf7a470);
  assert.equal(BAKED_BODY_VISUAL.color, 0xb4c8dc);
  assert.equal(ENVIRONMENT_VISUALS.source.terrainColor, 0x9a9aa0);
  assert.equal(ENVIRONMENT_VISUALS.scaled.terrainColor, 0x5c7a9e);
  assert.equal(ENVIRONMENT_VISUALS.source.objectColor, 0xff9f0a);
  assert.equal(ENVIRONMENT_VISUALS.scaled.objectColor, 0x6a9fd4);
  assert.equal(ROBOT_VISUAL.color, 0xc8ccd4);
});

test("projects the original Motion and workflow layer defaults", () => {
  const skeletonOnly = motion({ body_mesh: { available: false } });
  assert.deepEqual(
    defaultStageLayers({
      mode: "motion",
      motion: skeletonOnly,
      scaledMotion: null,
      robot: null,
      robotTrajectory: null,
    }),
    ["skeleton"],
  );

  const skinned = motion({ body_mesh: { available: true } });
  assert.deepEqual(
    defaultStageLayers({
      mode: "motion",
      motion: skinned,
      scaledMotion: null,
      robot: null,
      robotTrajectory: null,
    }),
    ["body"],
  );

  assert.deepEqual(
    defaultStageLayers({
      mode: "h2r",
      motion: skeletonOnly,
      scaledMotion: motion(),
      robot: {
        name: "robot",
        display_name: "Robot",
        links: [],
        link_transforms_zero: {},
      },
      robotTrajectory: { frames: [{ links: {} }] },
    }),
    ["skeleton", "scaled-skeleton", "robot"],
  );

  assert.deepEqual(
    defaultStageLayers({
      mode: "h2r-result",
      motion: motion({
        body_mesh: { available: true },
        objects: [{ extents: [1, 1, 1], positions: [], quaternions: [] }],
      }),
      scaledMotion: motion({
        terrain: { vertices: [[0, 0, 0]], faces: [[0, 0, 0]] },
      }),
      robot: {
        name: "robot",
        display_name: "Robot",
        links: [],
        link_transforms_zero: {},
      },
      robotTrajectory: { frames: [{ links: {} }] },
    }),
    ["skeleton", "scaled-skeleton", "scaled-scene", "robot"],
  );
});
