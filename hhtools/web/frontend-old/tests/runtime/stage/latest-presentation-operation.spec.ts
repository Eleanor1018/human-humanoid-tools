import { describe, expect, it } from "vitest";

import {
  LatestPresentationOperationCoordinator,
  reconcilePresentationWithFinalizer,
  type OwnedPresentationOperation,
  type PresentationProjector,
} from "../../../src/runtime/stage/latest-presentation-operation";

interface PresentationIntent {
  readonly name: string;
}

describe("LatestPresentationOperationCoordinator", () => {
  it("constructs and publishes without entering the host", () => {
    let projections = 0;
    const coordinator = new LatestPresentationOperationCoordinator<PresentationIntent>({
      project: () => {
        projections += 1;
        return undefined;
      },
    });

    expect(coordinator.reconcile()).toBe("unchanged");
    const publication = coordinator.publish({ name: "A" });

    expect(projections).toBe(0);
    expect(coordinator.current).toBe(publication.current);
    expect(coordinator.reconcile()).toBe("applied");
    expect(projections).toBe(1);
    expect(coordinator.reconcile()).toBe("unchanged");
    expect(projections).toBe(1);
  });

  it("replays C after A's reentrant host frame late-commits", () => {
    const order: string[] = [];
    let surface = "empty";
    let coordinator: LatestPresentationOperationCoordinator<PresentationIntent>;
    coordinator = new LatestPresentationOperationCoordinator({
      project: (target) => {
        const name = target.current?.value.name ?? "neutral";
        order.push(`${name}:start`);
        surface = name;
        if (name === "A") {
          coordinator.publish({ name: "C" });
          order.push(`C:${coordinator.reconcile()}`);
          surface = "A-late-commit";
          order.push("A:late-commit");
        }
        order.push(`${name}:end`);
        return undefined;
      },
    });

    coordinator.publish({ name: "A" });

    expect(coordinator.reconcile()).toBe("applied");
    expect(order).toEqual([
      "A:start",
      "C:deferred",
      "A:late-commit",
      "A:end",
      "C:start",
      "C:end",
    ]);
    expect(surface).toBe("C");
  });

  it("coalesces unprojected B when A publishes B and then C", () => {
    const projected: string[] = [];
    let coordinator: LatestPresentationOperationCoordinator<PresentationIntent>;
    coordinator = new LatestPresentationOperationCoordinator({
      project: (target) => {
        const name = target.current?.value.name ?? "neutral";
        projected.push(name);
        if (name === "A") {
          coordinator.publish({ name: "B" });
          coordinator.publish({ name: "C" });
        }
        return undefined;
      },
    });

    coordinator.publish({ name: "A" });
    coordinator.reconcile();

    expect(projected).toEqual(["A", "C"]);
    expect(coordinator.current?.value.name).toBe("C");
  });

  it("drains a reentrant publication even when its caller does not reconcile", () => {
    const projected: string[] = [];
    let coordinator: LatestPresentationOperationCoordinator<PresentationIntent>;
    coordinator = new LatestPresentationOperationCoordinator({
      project: (target) => {
        const name = target.current?.value.name ?? "neutral";
        projected.push(name);
        if (name === "A") coordinator.publish({ name: "C" });
        return undefined;
      },
    });

    coordinator.publish({ name: "A" });
    coordinator.reconcile();

    expect(projected).toEqual(["A", "C"]);
  });

  it("projects neutral after exact withdrawal and ignores stale withdrawal", () => {
    const projected: string[] = [];
    const coordinator = new LatestPresentationOperationCoordinator<PresentationIntent>({
      project: (target) => {
        projected.push(target.current?.value.name ?? "neutral");
        return undefined;
      },
    });
    const first = coordinator.publish({ name: "A" }).current;
    coordinator.reconcile();
    const second = coordinator.publish({ name: "B" }).current;

    expect(coordinator.withdraw(first)).toBeNull();
    expect(coordinator.current).toBe(second);
    expect(projected).toEqual(["A"]);
    expect(coordinator.withdraw(second)?.current).toBeNull();
    expect(coordinator.withdraw(second)).toBeNull();
    expect(projected).toEqual(["A"]);

    expect(coordinator.reconcile()).toBe("applied");
    expect(projected).toEqual(["A", "neutral"]);
    expect(coordinator.current).toBeNull();
  });

  it("invalidates captured authority permanently after a successor", () => {
    const capturedAuthorities: Array<() => boolean> = [];
    const coordinator = new LatestPresentationOperationCoordinator<PresentationIntent>({
      project: (target, authority) => {
        if (target.current?.value.name === "A") {
          capturedAuthorities.push(authority.isCurrent);
        }
        return undefined;
      },
    });
    coordinator.publish({ name: "A" });
    coordinator.reconcile();
    expect(capturedAuthorities[0]?.()).toBe(true);

    const second = coordinator.publish({ name: "B" }).current;
    expect(capturedAuthorities[0]?.()).toBe(false);
    coordinator.withdraw(second);
    expect(capturedAuthorities[0]?.()).toBe(false);
  });

  it("treats the same value as a new exact operation", () => {
    const value = { name: "same" };
    const coordinator = new LatestPresentationOperationCoordinator<PresentationIntent>({
      project: () => undefined,
    });

    const first = coordinator.publish(value).current;
    const second = coordinator.publish(value).current;

    expect(second.value).toBe(value);
    expect(second).not.toBe(first);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
  });

  it("preserves a current error identity and retries only when asked", () => {
    const failure = new Error("host unavailable");
    let shouldFail = true;
    let attempts = 0;
    const coordinator = new LatestPresentationOperationCoordinator<PresentationIntent>({
      project: () => {
        attempts += 1;
        if (shouldFail) throw failure;
        return undefined;
      },
    });
    coordinator.publish({ name: "A" });

    let thrown: unknown;
    try {
      coordinator.reconcile();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(attempts).toBe(1);

    shouldFail = false;
    expect(coordinator.reconcile()).toBe("applied");
    expect(attempts).toBe(2);
  });

  it("applies a successor before rethrowing the stale operation error", () => {
    const failure = new Error("A failed late");
    const projected: string[] = [];
    let coordinator: LatestPresentationOperationCoordinator<PresentationIntent>;
    coordinator = new LatestPresentationOperationCoordinator({
      project: (target) => {
        const name = target.current?.value.name ?? "neutral";
        projected.push(name);
        if (name === "A") {
          coordinator.publish({ name: "C" });
          throw failure;
        }
        return undefined;
      },
    });
    coordinator.publish({ name: "A" });

    let thrown: unknown;
    try {
      coordinator.reconcile();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(projected).toEqual(["A", "C"]);
    expect(coordinator.reconcile()).toBe("unchanged");
  });

  it("finalizes the applied successor before rethrowing a stale error", () => {
    const failure = new Error("A failed late");
    const followedUp: string[] = [];
    let lastApplied: OwnedPresentationOperation<PresentationIntent> | null = null;
    let coordinator: LatestPresentationOperationCoordinator<PresentationIntent>;
    coordinator = new LatestPresentationOperationCoordinator({
      project: (target, authority) => {
        const operation = target.current;
        if (!operation) return undefined;
        if (operation.value.name === "A") {
          coordinator.publish({ name: "C" });
          throw failure;
        }
        if (authority.isCurrent()) lastApplied = operation;
        return undefined;
      },
    });
    coordinator.publish({ name: "A" });

    let thrown: unknown;
    try {
      reconcilePresentationWithFinalizer(coordinator, () => {
        if (coordinator.current === lastApplied && lastApplied) {
          followedUp.push(lastApplied.value.name);
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(coordinator.current?.value.name).toBe("C");
    expect(followedUp).toEqual(["C"]);
  });

  it("preserves reconciliation and finalizer failures in causal order", () => {
    const reconcileFailure = new Error("projection failed");
    const finalizerFailure = new Error("follow-up failed");
    const coordinator = new LatestPresentationOperationCoordinator<
      PresentationIntent
    >({
      project: () => {
        throw reconcileFailure;
      },
    });
    coordinator.publish({ name: "A" });

    let thrown: unknown;
    try {
      reconcilePresentationWithFinalizer(coordinator, () => {
        throw finalizerFailure;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      reconcileFailure,
      finalizerFailure,
    ]);
  });

  it("flattens stale and current projection failures in causal order", () => {
    const projected: string[] = [];
    let cShouldFail = true;
    let coordinator: LatestPresentationOperationCoordinator<PresentationIntent>;
    coordinator = new LatestPresentationOperationCoordinator({
      project: (target) => {
        const name = target.current?.value.name;
        if (name) projected.push(name);
        if (name === "A") {
          coordinator.publish({ name: "C" });
          throw new AggregateError([
            new Error("A-1"),
            new AggregateError([new Error("A-2")]),
          ]);
        }
        if (name === "C" && cShouldFail) {
          throw new AggregateError([new Error("C-1"), new Error("C-2")]);
        }
        return undefined;
      },
    });
    coordinator.publish({ name: "A" });

    let thrown: unknown;
    try {
      coordinator.reconcile();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map(
      (error) => (error as Error).message,
    )).toEqual(["A-1", "A-2", "C-1", "C-2"]);
    expect(projected).toEqual(["A", "C"]);

    cShouldFail = false;
    expect(coordinator.reconcile()).toBe("applied");
    expect(projected).toEqual(["A", "C", "C"]);
  });

  it("does not project the same generation twice under reentrant reconcile", () => {
    let calls = 0;
    let nested: string | null = null;
    let coordinator: LatestPresentationOperationCoordinator<PresentationIntent>;
    coordinator = new LatestPresentationOperationCoordinator({
      project: () => {
        calls += 1;
        nested = coordinator.reconcile();
        return undefined;
      },
    });
    coordinator.publish({ name: "A" });

    expect(coordinator.reconcile()).toBe("applied");
    expect(nested).toBe("deferred");
    expect(calls).toBe(1);
  });

  it("bounds continual churn and leaves the latest generation pending", () => {
    let next = 0;
    let coordinator: LatestPresentationOperationCoordinator<PresentationIntent>;
    coordinator = new LatestPresentationOperationCoordinator({
      project: () => {
        coordinator.publish({ name: `successor-${next += 1}` });
        return undefined;
      },
    });
    coordinator.publish({ name: "A" });

    expect(() => coordinator.reconcile()).toThrow(
      "Presentation projection did not reach a stable operation",
    );
    expect(next).toBe(
      LatestPresentationOperationCoordinator.MAX_RECONCILE_PASSES,
    );
    expect(coordinator.current?.value.name).toBe(`successor-${next}`);
  });

  it("keeps neutral authority exact when withdrawal reenters publication", () => {
    const observed: string[] = [];
    let successor: OwnedPresentationOperation<PresentationIntent> | null = null;
    let coordinator: LatestPresentationOperationCoordinator<PresentationIntent>;
    coordinator = new LatestPresentationOperationCoordinator({
      project: (target, authority) => {
        if (target.current) {
          observed.push(target.current.value.name);
          return undefined;
        }
        observed.push(`neutral:${authority.isCurrent()}`);
        successor = coordinator.publish({ name: "C" }).current;
        observed.push(`neutral-after-C:${authority.isCurrent()}`);
        return undefined;
      },
    });
    const first = coordinator.publish({ name: "A" }).current;
    coordinator.reconcile();
    coordinator.withdraw(first);

    coordinator.reconcile();

    expect(observed).toEqual([
      "A",
      "neutral:true",
      "neutral-after-C:false",
      "C",
    ]);
    expect(successor && coordinator.isCurrent(successor)).toBe(true);
  });

  it("rejects an asynchronous projector at the type boundary", () => {
    // A Promise would let projection outlive its exact synchronous host frame.
    // @ts-expect-error Presentation projectors must finish synchronously.
    const projector: PresentationProjector<PresentationIntent> = async () => undefined;
    expect(projector).toBeTypeOf("function");
  });
});
