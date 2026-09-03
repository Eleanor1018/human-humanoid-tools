import { describe, expect, it, vi } from "vitest";

import {
  CoalescedAsyncFrameTask,
  type AsyncFrameCallback,
  type AsyncFrameScheduler,
} from "../../../src/runtime/stage/coalesced-async-frame-task";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function frameHarness() {
  let nextHandle = 1;
  const callbacks = new Map<number, AsyncFrameCallback>();
  const requestFrame = vi.fn((callback: AsyncFrameCallback) => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  });
  const cancelFrame = vi.fn((_handle: number) => undefined);
  const scheduler: AsyncFrameScheduler = { requestFrame, cancelFrame };

  return {
    scheduler,
    requestFrame,
    cancelFrame,
    fire(handle: number): void {
      const callback = callbacks.get(handle);
      if (!callback) throw new Error(`unknown animation frame ${handle}`);
      callback(16);
    },
  };
}

async function drainPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CoalescedAsyncFrameTask", () => {
  it("stays inert until a session starts", () => {
    const frames = frameHarness();
    const execute = vi.fn(async () => 1);
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute,
      commit: vi.fn(),
      reportError: vi.fn(),
    });

    task.schedule();
    task.flush();
    task.stop();

    expect(frames.requestFrame).not.toHaveBeenCalled();
    expect(frames.cancelFrame).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("coalesces each frame and retains one latest-state follow-up", async () => {
    const frames = frameHarness();
    const first = deferred<number>();
    let latest = 1;
    const execute = vi
      .fn<() => Promise<number>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async () => latest);
    const commit = vi.fn<(result: number) => void>();
    const reportError = vi.fn<(error: unknown) => void>();
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute,
      commit,
      reportError,
    });

    task.start();
    task.schedule();
    task.schedule();
    task.schedule();
    expect(frames.requestFrame).toHaveBeenCalledOnce();

    frames.fire(1);
    expect(execute).toHaveBeenCalledOnce();
    latest = 4;
    task.schedule();
    task.schedule();
    expect(frames.requestFrame).toHaveBeenCalledOnce();

    first.resolve(1);
    await drainPromises();
    expect(commit).toHaveBeenCalledWith(1);
    expect(frames.requestFrame).toHaveBeenCalledTimes(2);

    frames.fire(2);
    await drainPromises();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith(4);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("flushes a scheduled frame and ignores its escaped callback", async () => {
    const frames = frameHarness();
    const execute = vi.fn(async () => 7);
    const commit = vi.fn<(result: number) => void>();
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute,
      commit,
      reportError: vi.fn(),
    });

    task.start();
    task.schedule();
    task.flush();

    expect(frames.cancelFrame).toHaveBeenCalledWith(1);
    expect(execute).toHaveBeenCalledOnce();
    frames.fire(1);
    await drainPromises();
    expect(execute).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("terminalizes before an escaped canceled frame can run", () => {
    const frames = frameHarness();
    const execute = vi.fn(async () => 1);
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute,
      commit: vi.fn(),
      reportError: vi.fn(),
    });

    task.start();
    task.schedule();
    task.stop();
    expect(frames.cancelFrame).toHaveBeenCalledWith(1);

    frames.fire(1);
    task.schedule();
    expect(execute).not.toHaveBeenCalled();
    expect(frames.requestFrame).toHaveBeenCalledOnce();
  });

  it("preserves the last re-entrant ownership decision during cancellation", async () => {
    const frames = frameHarness();
    const execute = vi.fn(async () => 3);
    const commit = vi.fn<(result: number) => void>();
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute,
      commit,
      reportError: vi.fn(),
    });
    let reentered = false;
    frames.cancelFrame.mockImplementation(() => {
      if (reentered) return;
      reentered = true;
      task.start();
      task.schedule();
    });

    task.start();
    task.schedule();
    task.start();

    expect(frames.requestFrame).toHaveBeenCalledTimes(2);
    frames.fire(2);
    await drainPromises();
    expect(execute).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(3);
  });

  it("keeps stop and flush terminal when frame cancellation throws", async () => {
    const frames = frameHarness();
    const execute = vi.fn(async () => 5);
    const commit = vi.fn<(result: number) => void>();
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute,
      commit,
      reportError: vi.fn(),
    });
    frames.cancelFrame.mockImplementation(() => {
      throw new Error("cancel failed");
    });

    task.start();
    task.schedule();
    expect(() => task.stop()).not.toThrow();
    frames.fire(1);
    expect(execute).not.toHaveBeenCalled();

    task.start();
    task.schedule();
    expect(() => task.flush()).not.toThrow();
    expect(execute).toHaveBeenCalledOnce();
    frames.fire(2);
    await drainPromises();
    expect(execute).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(5);
  });

  it("starts a replacement without waiting for the old request", async () => {
    const frames = frameHarness();
    const first = deferred<number>();
    const second = deferred<number>();
    const execute = vi
      .fn<() => Promise<number>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const commit = vi.fn<(result: number) => void>();
    const reportError = vi.fn<(error: unknown) => void>();
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute,
      commit,
      reportError,
    });

    task.start();
    task.schedule();
    frames.fire(1);
    task.schedule();

    task.stop();
    task.start();
    task.schedule();
    frames.fire(2);
    expect(execute).toHaveBeenCalledTimes(2);

    second.resolve(2);
    await drainPromises();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenLastCalledWith(2);

    first.resolve(1);
    await drainPromises();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(frames.requestFrame).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("suppresses an old rejection without mutating the new session", async () => {
    const frames = frameHarness();
    const first = deferred<number>();
    const second = deferred<number>();
    const execute = vi
      .fn<() => Promise<number>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const commit = vi.fn<(result: number) => void>();
    const reportError = vi.fn<(error: unknown) => void>();
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute,
      commit,
      reportError,
    });

    task.start();
    task.schedule();
    frames.fire(1);
    task.stop();
    task.start();
    task.schedule();
    frames.fire(2);

    first.reject(new Error("late failure"));
    await drainPromises();
    expect(reportError).not.toHaveBeenCalled();

    second.resolve(2);
    await drainPromises();
    expect(commit).toHaveBeenCalledWith(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports only current failures and still services the queued frame", async () => {
    const frames = frameHarness();
    const first = deferred<number>();
    const execute = vi
      .fn<() => Promise<number>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(2);
    const commit = vi.fn<(result: number) => void>();
    const failure = new Error("current failure");
    const reportError = vi.fn<(error: unknown) => void>();
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute,
      commit,
      reportError,
    });

    task.start();
    task.schedule();
    frames.fire(1);
    task.schedule();
    first.reject(failure);
    await drainPromises();

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(frames.requestFrame).toHaveBeenCalledTimes(2);
    frames.fire(2);
    await drainPromises();
    expect(commit).toHaveBeenCalledWith(2);
  });

  it("contains a throwing diagnostic reporter", async () => {
    const frames = frameHarness();
    const task = new CoalescedAsyncFrameTask({
      scheduler: frames.scheduler,
      execute: async () => {
        throw new Error("request failed");
      },
      commit: vi.fn(),
      reportError: () => {
        throw new Error("reporter failed");
      },
    });

    task.start();
    task.schedule();
    frames.fire(1);
    await drainPromises();

    task.schedule();
    expect(frames.requestFrame).toHaveBeenCalledTimes(2);
  });
});
