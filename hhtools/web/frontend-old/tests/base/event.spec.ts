import { describe, expect, it } from "vitest";

import { Emitter } from "../../src/base/common/event";

describe("Emitter", () => {
  it("delivers values until the listener is disposed", () => {
    const emitter = new Emitter<number>();
    const received: number[] = [];
    const subscription = emitter.event((value) => received.push(value));

    emitter.fire(1);
    subscription.dispose();
    emitter.fire(2);

    expect(received).toEqual([1]);
  });

  it("uses a listener snapshot for each delivery", () => {
    const emitter = new Emitter<string>();
    const received: string[] = [];
    let secondSubscription = { dispose() {} };

    emitter.event((value) => {
      received.push(`first:${value}`);
      secondSubscription.dispose();
      emitter.event((next) => received.push(`late:${next}`));
    });
    secondSubscription = emitter.event((value) => {
      received.push(`second:${value}`);
    });

    emitter.fire("one");
    emitter.fire("two");

    expect(received).toEqual([
      "first:one",
      "second:one",
      "first:two",
      "late:two",
    ]);
  });

  it("keeps duplicate callback subscriptions independent", () => {
    const emitter = new Emitter<void>();
    let calls = 0;
    const listener = () => calls++;
    const first = emitter.event(listener);
    emitter.event(listener);

    first.dispose();
    emitter.fire();

    expect(calls).toBe(1);
  });

  it("delivers to sibling listeners before reporting one failure", () => {
    const emitter = new Emitter<number>();
    const failure = new Error("broken observer");
    const received: number[] = [];
    emitter.event(() => {
      throw failure;
    });
    emitter.event((value) => received.push(value));

    expect(() => emitter.fire(42)).toThrow(failure);
    expect(received).toEqual([42]);
  });

  it("aggregates multiple listener failures after completing delivery", () => {
    const emitter = new Emitter<void>();
    const failures = [new Error("first"), new Error("second")];
    for (const failure of failures) {
      emitter.event(() => {
        throw failure;
      });
    }

    let reported: unknown;
    try {
      emitter.fire();
    } catch (error) {
      reported = error;
    }

    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors).toEqual(failures);
  });

  it("stops existing and future listeners after disposal", () => {
    const emitter = new Emitter<number>();
    const received: number[] = [];
    emitter.event((value) => received.push(value));

    emitter.dispose();
    emitter.fire(1);
    const lateSubscription = emitter.event((value) => received.push(value));
    emitter.fire(2);

    expect(received).toEqual([]);
    expect(() => lateSubscription.dispose()).not.toThrow();
    expect(() => emitter.dispose()).not.toThrow();
  });
});
