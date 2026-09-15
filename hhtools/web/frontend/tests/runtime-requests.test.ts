import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeConnection } from "../src/features/runtime/api.ts";
import { waitForPeer } from "../src/features/runtime/peerState.ts";

test("connection identity requests time out and preserve authentication", async (t) => {
  let signal: AbortSignal;
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    assert.equal(
      new Headers(init.headers).get("Authorization"), "Bearer test-token",
    );
    signal = init.signal!;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const client = new RuntimeConnection("http://localhost", "test-token");
  await assert.rejects(client.connect(undefined, { timeoutMs: 10 }), {
    name: "TimeoutError",
  });
  assert.equal(signal!.aborted, true);
  assert.equal(client.identity, null);
});

test("cancelling JSON body consumption aborts the same request", async (t) => {
  const cancellation = new AbortController();
  let reading: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
        once: true,
      });
      reading();
    }),
  }));
  const request = new RuntimeConnection("http://localhost").json(
    "/test", "GET", undefined,
    { signal: cancellation.signal, timeoutMs: 1000 },
  );
  await started;
  cancellation.abort();
  await assert.rejects(request, { name: "AbortError" });
});

test("an already cancelled attempt never sends an HTTP request", async (t) => {
  const fetcher = t.mock.method(globalThis, "fetch");
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(
    new RuntimeConnection("http://localhost").connect(undefined, {
      signal: cancellation.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(fetcher.mock.callCount(), 0);
});

test("successful JSON requests clear their deadline and cancellation listener", async (t) => {
  const cancellation = new AbortController();
  let signal: AbortSignal;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    return Response.json({ ok: true });
  });
  const result = await new RuntimeConnection("http://localhost").json(
    "/test", "GET", undefined,
    { signal: cancellation.signal, timeoutMs: 10 },
  );
  cancellation.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(result, { ok: true });
  assert.equal(signal!.aborted, false);
});

test("ICE waits cancel and peer connection waits have their own deadline", async (t) => {
  const target = new EventTarget();
  const peer = Object.assign(target, {
    connectionState: "new", iceGatheringState: "gathering",
  }) as unknown as RTCPeerConnection;
  const remove = t.mock.method(target, "removeEventListener");
  const cancellation = new AbortController();
  const gathering = waitForPeer(peer, "icegatheringstatechange", cancellation.signal);
  cancellation.abort();
  await assert.rejects(gathering, { name: "AbortError" });
  assert.equal(remove.mock.callCount(), 1);
  await assert.rejects(
    waitForPeer(peer, "connectionstatechange", new AbortController().signal, 10),
    /timed out/,
  );
  assert.equal(remove.mock.callCount(), 2);
});
