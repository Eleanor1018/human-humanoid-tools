import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LazyThreeStageRendererMount,
  type StartableThreeStageRenderer,
  type ThreeStageRendererFactory,
  type ThreeStageRendererFactoryLoader,
} from "../../src/workbench/browser/stage/lazy-three-stage-renderer-mount";
import type { ThreeStageDomReferences } from "../../src/workbench/browser/stage/three-stage-renderer-mount";
import type { IStageViewAttachment } from "../../src/workbench/services/stage/common/stage-view";

afterEach(() => {
  document.body.replaceChildren();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stageDom(): ThreeStageDomReferences {
  const stage = document.createElement("main");
  const canvas = document.createElement("canvas");
  stage.append(canvas);
  document.body.append(stage);
  return { stage, canvas };
}

function renderer(
  overrides: Partial<StartableThreeStageRenderer> = {},
): StartableThreeStageRenderer {
  return {
    start: vi.fn(),
    resetView: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

function attachment(
  attachView: IStageViewAttachment["attachView"],
): IStageViewAttachment {
  return { attachView };
}

async function flushActivation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LazyThreeStageRendererMount", () => {
  it("does not invoke the renderer factory when teardown wins loading", async () => {
    const pending = deferred<ThreeStageRendererFactory>();
    const factory = vi.fn(() => renderer());
    const mount = new LazyThreeStageRendererMount({
      loader: { load: () => pending.promise },
      stageViewAttachment: attachment(vi.fn()),
      reportError: vi.fn(),
    });

    const lease = mount.mount(stageDom());
    lease.dispose();
    pending.resolve(factory);
    await flushActivation();

    expect(factory).not.toHaveBeenCalled();
  });

  it("attaches an inert owner before starting and detaches before disposal", async () => {
    const order: string[] = [];
    const stageRenderer = renderer({
      start: () => order.push("start"),
      dispose: () => order.push("dispose"),
    });
    const factory = vi.fn(() => {
      order.push("create");
      return stageRenderer;
    });
    const loader: ThreeStageRendererFactoryLoader = {
      load: async () => factory,
    };
    const mount = new LazyThreeStageRendererMount({
      loader,
      stageViewAttachment: attachment((view) => {
        expect(view).toBe(stageRenderer);
        order.push("attach");
        return { dispose: () => order.push("detach") };
      }),
      reportError: vi.fn(),
    });

    const dom = stageDom();
    const lease = mount.mount(dom);
    await flushActivation();
    expect(factory).toHaveBeenCalledWith(dom);
    expect(order).toEqual(["create", "attach", "start"]);

    lease.dispose();
    expect(order).toEqual([
      "create",
      "attach",
      "start",
      "detach",
      "dispose",
    ]);
  });

  it("uses the attachment guard before start can allocate WebGL", async () => {
    const attachmentFailure = new Error("another Stage View is attached");
    const stageRenderer = renderer();
    const reportError = vi.fn();
    const mount = new LazyThreeStageRendererMount({
      loader: { load: async () => () => stageRenderer },
      stageViewAttachment: attachment(() => {
        throw attachmentFailure;
      }),
      reportError,
    });

    const lease = mount.mount(stageDom());
    await flushActivation();

    expect(stageRenderer.start).not.toHaveBeenCalled();
    expect(stageRenderer.dispose).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(attachmentFailure);
    lease.dispose();
    expect(stageRenderer.dispose).toHaveBeenCalledOnce();
  });

  it("rolls back attachment before renderer when start fails", async () => {
    const order: string[] = [];
    const startFailure = new Error("start failed");
    const reportError = vi.fn();
    const stageRenderer = renderer({
      start: () => {
        order.push("start");
        throw startFailure;
      },
      dispose: () => order.push("dispose"),
    });
    const mount = new LazyThreeStageRendererMount({
      loader: { load: async () => () => stageRenderer },
      stageViewAttachment: attachment(() => {
        order.push("attach");
        return { dispose: () => order.push("detach") };
      }),
      reportError,
    });

    const lease = mount.mount(stageDom());
    await flushActivation();

    expect(order).toEqual(["attach", "start", "detach", "dispose"]);
    expect(reportError).toHaveBeenCalledWith(startFailure);
    lease.dispose();
    expect(order).toEqual(["attach", "start", "detach", "dispose"]);
  });

  it("treats re-entrant teardown during start as a stale completion", async () => {
    const pending = deferred<ThreeStageRendererFactory>();
    const order: string[] = [];
    const reportError = vi.fn();
    let lease!: { dispose(): void };
    const stageRenderer = renderer({
      start: () => {
        order.push("start");
        lease.dispose();
        throw new Error("start was cancelled");
      },
      dispose: () => order.push("dispose"),
    });
    const mount = new LazyThreeStageRendererMount({
      loader: { load: () => pending.promise },
      stageViewAttachment: attachment(() => {
        order.push("attach");
        return { dispose: () => order.push("detach") };
      }),
      reportError,
    });

    lease = mount.mount(stageDom());
    pending.resolve(() => stageRenderer);
    await flushActivation();

    expect(order).toEqual(["attach", "start", "detach", "dispose"]);
    expect(reportError).not.toHaveBeenCalled();
    expect(() => lease.dispose()).not.toThrow();
    expect(order).toEqual(["attach", "start", "detach", "dispose"]);
  });

  it("reports active loader failures but ignores rejection after teardown", async () => {
    const first = deferred<ThreeStageRendererFactory>();
    const second = deferred<ThreeStageRendererFactory>();
    const loader: ThreeStageRendererFactoryLoader = {
      load: vi
        .fn<() => Promise<ThreeStageRendererFactory>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const reportError = vi.fn();
    const mount = new LazyThreeStageRendererMount({
      loader,
      stageViewAttachment: attachment(vi.fn()),
      reportError,
    });
    const activeFailure = new Error("active load failed");
    const staleFailure = new Error("stale load failed");

    const firstLease = mount.mount(stageDom());
    first.reject(activeFailure);
    await flushActivation();
    expect(reportError).toHaveBeenCalledWith(activeFailure);

    // An async failure terminalizes only its own record; recovery need not wait
    // for React to invoke the now-stale cleanup closure.
    const secondLease = mount.mount(stageDom());
    firstLease.dispose();
    secondLease.dispose();
    second.reject(staleFailure);
    await flushActivation();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("rolls back a synchronous loader throw before returning a lease", async () => {
    const loadFailure = new Error("load threw");
    const goodRenderer = renderer();
    const loader: ThreeStageRendererFactoryLoader = {
      load: vi
        .fn<() => Promise<ThreeStageRendererFactory>>()
        .mockImplementationOnce(() => {
          throw loadFailure;
        })
        .mockResolvedValueOnce(() => goodRenderer),
    };
    const mount = new LazyThreeStageRendererMount({
      loader,
      stageViewAttachment: attachment(() => ({ dispose: vi.fn() })),
      reportError: vi.fn(),
    });

    expect(() => mount.mount(stageDom())).toThrow(loadFailure);
    const lease = mount.mount(stageDom());
    await flushActivation();
    expect(goodRenderer.start).toHaveBeenCalledOnce();
    lease.dispose();
  });

  it("releases every owner before surfacing terminal lease failures", async () => {
    const order: string[] = [];
    const detachFailure = new Error("detach failed");
    const rendererFailure = new Error("renderer dispose failed");
    const reportError = vi.fn();
    const mount = new LazyThreeStageRendererMount({
      loader: {
        load: async () => () =>
          renderer({
            dispose: () => {
              order.push("dispose");
              throw rendererFailure;
            },
          }),
      },
      stageViewAttachment: attachment(() => ({
        dispose: () => {
          order.push("detach");
          throw detachFailure;
        },
      })),
      reportError,
    });

    const lease = mount.mount(stageDom());
    await flushActivation();

    let thrown: unknown;
    try {
      lease.dispose();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      detachFailure,
      rendererFailure,
    ]);
    expect(order).toEqual(["detach", "dispose"]);
    expect(reportError).not.toHaveBeenCalled();
    expect(() => lease.dispose()).not.toThrow();
  });

  it("isolates its reporter when handling an asynchronous failure", async () => {
    const loadFailure = new Error("load failed");
    const mount = new LazyThreeStageRendererMount({
      loader: { load: () => Promise.reject(loadFailure) },
      stageViewAttachment: attachment(vi.fn()),
      reportError: () => {
        throw new Error("reporter failed");
      },
    });

    const lease = mount.mount(stageDom());
    await flushActivation();
    expect(() => lease.dispose()).not.toThrow();
  });
});
