import assert from "node:assert/strict";
import test from "node:test";

import {
  clientIceServers,
  configuredStreamPort,
  runtimeEndpoint,
  streamDimensions,
} from "../src/features/runtime/connectionSettings.ts";

test("server and signal port resolve local and secure remote Runtime origins", () => {
  assert.equal(runtimeEndpoint("127.0.0.1", "58800"), "http://127.0.0.1:58800");
  assert.equal(
    runtimeEndpoint("compute.example", "8443"),
    "https://compute.example:8443",
  );
  assert.equal(runtimeEndpoint("[::1]", "8009"), "http://[::1]:8009");
  assert.equal(
    runtimeEndpoint("https://localhost", "443"),
    "https://localhost",
  );
  for (const port of ["0", "65536", "12.5", "", "10x"])
    assert.throws(() => runtimeEndpoint("localhost", port));
  for (const server of [
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/#token",
  ])
    assert.throws(() => runtimeEndpoint(server, "443"));
});

test("stream port overrides only TURN addresses and preserves relay credentials", () => {
  const original = [
    {
      urls: ["stun:stun.example:3478", "turn:127.0.0.1:58820?transport=tcp"],
      username: "operator",
      credential: "test-secret",
    },
  ];
  assert.equal(configuredStreamPort(original), "58820");
  assert.deepEqual(clientIceServers(original, "58920"), [
    {
      ...original[0],
      urls: ["stun:stun.example:3478", "turn:127.0.0.1:58920?transport=tcp"],
    },
  ]);
  assert.equal(original[0].urls[1], "turn:127.0.0.1:58820?transport=tcp");
  assert.deepEqual(clientIceServers(original, null), original);
  assert.throws(() => clientIceServers([], "58820"), /no TURN server/);
  assert.equal(
    configuredStreamPort([{ urls: "turns:[::1]?transport=tcp" }]),
    "5349",
  );
});

test("resolution modes use fixed dimensions or bounded window dimensions", () => {
  assert.deepEqual(streamDimensions("1280x720", 390, 796), {
    width: 1280,
    height: 720,
  });
  assert.deepEqual(streamDimensions("1920x1080", 1280, 720), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(streamDimensions("auto", 390, 796), {
    width: 390,
    height: 796,
  });
  assert.deepEqual(streamDimensions("auto", 4000, 100), {
    width: 1920,
    height: 320,
  });
});
