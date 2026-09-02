import { describe, expect, it, vi } from "vitest";

import {
  DisposableStore,
  toDisposable,
} from "../../src/base/common/disposable";

describe("DisposableStore", () => {
  it("releases owned resources once in reverse registration order", () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push("first")));
    store.add(toDisposable(() => order.push("second")));

    store.dispose();
    store.dispose();

    expect(order).toEqual(["second", "first"]);
  });

  it("immediately releases a resource added after its owner was disposed", () => {
    const dispose = vi.fn();
    const store = new DisposableStore();
    store.dispose();

    store.add({ dispose });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("continues cleanup when one participant fails", () => {
    const order: string[] = [];
    const failure = new Error("broken cleanup");
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push("first")));
    store.add(
      toDisposable(() => {
        order.push("failing");
        throw failure;
      }),
    );
    store.add(toDisposable(() => order.push("last")));

    let thrown: unknown;
    try {
      store.dispose();
    } catch (error) {
      thrown = error;
    }

    expect(order).toEqual(["last", "failing", "first"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([failure]);
    expect(() => store.dispose()).not.toThrow();
  });
});

describe("toDisposable", () => {
  it("turns cleanup callbacks into one-shot disposables", () => {
    const cleanup = vi.fn();
    const disposable = toDisposable(cleanup);

    disposable.dispose();
    disposable.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
