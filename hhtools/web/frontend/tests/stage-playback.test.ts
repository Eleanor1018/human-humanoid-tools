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
import {
  defaultR2rStageLayers,
  defaultStageLayers,
  projectR2rStageVisibility,
  r2rLayerAvailability,
  r2rPlaybackTimeline,
  r2rVisibilityIdentity,
} from "../src/stage/presentation.ts";
import type {
  StageMotionPayload,
  StageR2rActorPayload,
  StageR2rPresentationPayload,
  StageRobotPayload,
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

function robot(name: string): StageRobotPayload {
  return {
    name,
    display_name: name,
    links: [],
    link_transforms_zero: {},
  };
}

function r2rActor(
  overrides: Partial<StageR2rActorPayload> = {},
): StageR2rActorPayload {
  return {
    robot: null,
    trajectory: null,
    skeleton: null,
    environment: null,
    ...overrides,
  };
}

function r2rPresentation(
  overrides: Partial<StageR2rPresentationPayload> = {},
): StageR2rPresentationPayload {
  return {
    phase: "source",
    source: r2rActor(),
    target: r2rActor(),
    calibrationReference: null,
    sourceToken: null,
    resultToken: null,
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
  assert.equal(SKELETON_VISUALS["r2r-source"].color, 0x60a5fa);
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

test("projects R2R layer availability independently for both actors", () => {
  const scene = motion({
    positions: [],
    objects: [{ extents: [1, 1, 1], positions: [], quaternions: [] }],
  });
  assert.deepEqual(
    r2rLayerAvailability(r2rPresentation({
      source: r2rActor({ robot: robot("source"), environment: scene }),
      target: r2rActor({ skeleton: motion() }),
    })),
    {
      "r2r-source-robot": true,
      "r2r-source-skeleton": false,
      "r2r-source-scene": true,
      "r2r-target-robot": false,
      "r2r-target-skeleton": true,
      "r2r-target-scene": false,
    },
  );
});

test("reproduces legacy R2R source and overlay defaults", () => {
  const scene = motion({
    positions: [],
    terrain: { vertices: [[0, 0, 0]], faces: [[0, 0, 0]] },
  });
  const complete = r2rPresentation({
    source: r2rActor({
      robot: robot("source"),
      skeleton: motion(),
      environment: scene,
    }),
    target: r2rActor({
      robot: robot("target"),
      skeleton: motion(),
      environment: scene,
    }),
  });
  assert.deepEqual(defaultR2rStageLayers(complete), [
    "r2r-source-robot",
    "r2r-source-scene",
  ]);
  assert.deepEqual(
    defaultR2rStageLayers({ ...complete, phase: "result", resultToken: "result" }),
    [
      "r2r-source-robot",
      "r2r-target-robot",
      "r2r-target-skeleton",
      "r2r-target-scene",
    ],
  );
  assert.deepEqual(
    defaultR2rStageLayers({ ...complete, phase: "calibration" }),
    ["r2r-target-robot"],
  );
});

test("calibration physically isolates the target robot and reference", () => {
  const calibration = r2rPresentation({
    phase: "calibration",
    source: r2rActor({ robot: robot("source"), skeleton: motion() }),
    target: r2rActor({ robot: robot("target"), skeleton: motion() }),
    calibrationReference: motion(),
  });
  assert.deepEqual(
    projectR2rStageVisibility(calibration, [
      "r2r-source-robot",
      "r2r-source-skeleton",
      "r2r-source-scene",
      "r2r-target-robot",
      "r2r-target-skeleton",
      "r2r-target-scene",
    ]),
    {
      sourceRobot: false,
      sourceSkeleton: false,
      sourceScene: false,
      targetRobot: true,
      targetSkeleton: false,
      targetScene: false,
      calibrationReference: true,
    },
  );
  assert.equal(r2rPlaybackTimeline(calibration), null);
});

test("uses the longest source or target actor timeline for R2R playback", () => {
  const shortTrajectory: StageRobotTrajectoryPayload = {
    frames: [{ links: {} }, { links: {} }],
    playback_duration: 1,
  };
  const longTrajectory: StageRobotTrajectoryPayload = {
    frames: [{ links: {} }, { links: {} }],
    playback_duration: 9,
  };
  const longSkeleton = motion({ playback_duration: 8 });
  const cases: readonly StageR2rPresentationPayload[] = [
    r2rPresentation({
      source: r2rActor({ trajectory: longTrajectory }),
      target: r2rActor({ trajectory: shortTrajectory }),
    }),
    r2rPresentation({
      source: r2rActor({ trajectory: shortTrajectory }),
      target: r2rActor({ trajectory: longTrajectory }),
    }),
    r2rPresentation({
      source: r2rActor({ skeleton: longSkeleton }),
      target: r2rActor({ trajectory: shortTrajectory }),
    }),
    r2rPresentation({
      source: r2rActor({ trajectory: shortTrajectory }),
      target: r2rActor({ skeleton: longSkeleton }),
    }),
  ];
  assert.equal(r2rPlaybackTimeline(cases[0]), longTrajectory);
  assert.equal(r2rPlaybackTimeline(cases[1]), longTrajectory);
  assert.equal(r2rPlaybackTimeline(cases[2]), longSkeleton);
  assert.equal(r2rPlaybackTimeline(cases[3]), longSkeleton);
  assert.equal(r2rPlaybackTimeline(r2rPresentation()), null);
});

test("keeps R2R visibility identity stable across presentation clones", () => {
  const value = r2rPresentation({
    source: r2rActor({ robot: robot("source") }),
    target: r2rActor({ robot: robot("target") }),
    sourceToken: "source-token",
  });
  assert.equal(r2rVisibilityIdentity(value), r2rVisibilityIdentity({ ...value }));
  assert.notEqual(
    r2rVisibilityIdentity(value),
    r2rVisibilityIdentity({ ...value, resultToken: "result-token" }),
  );
});
