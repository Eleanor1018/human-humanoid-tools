import { describe, expect, it } from "vitest";

import {
  LatestSessionLifecycle,
  type SessionLifecycleLease,
} from "../../../src/runtime/stage/latest-session-lifecycle";

interface FakeResources {
  readonly name: string;
  handles: string[];
}

type FakeSession = SessionLifecycleLease<string, FakeResources>;

describe("LatestSessionLifecycle", () => {
  it("drains A and reserved B when B stops before start", () => {
    const cleaned: string[] = [];
    const lifecycle = new LatestSessionLifecycle<string, FakeResources>({
      cleanup: (session) => cleaned.push(session.value.value.name),
    });
    const first = lifecycle.reserve("h2r", { name: "A", handles: [] });
    expect(first.kind).toBe("reserved");
    lifecycle.start(first.kind === "reserved" ? first.session : null!, () => {});
    const second = lifecycle.reserve("h2r", { name: "B", handles: [] });
    expect(second.kind).toBe("reserved");

    const result = lifecycle.stop(
      second.kind === "reserved" ? second.session : null!,
    );

    expect(result).toBe("stopped");
    expect(cleaned).toEqual(["A", "B"]);
    expect(first.kind === "reserved" && first.session.value.phase).toBe("stopped");
    expect(second.kind === "reserved" && second.session.value.phase).toBe("stopped");
    expect(lifecycle.current).toBeNull();
    expect(lifecycle.stop(second.kind === "reserved" ? second.session : null!))
      .toBe("stale");
    expect(cleaned).toEqual(["A", "B"]);
  });

  it("keeps exact A cleanup running when it reenters with C", () => {
    const exact: string[] = [];
    const shared: string[] = [];
    let third: FakeSession | null = null;
    let secondSession: FakeSession | null = null;
    let secondSetups = 0;
    let lifecycle: LatestSessionLifecycle<string, FakeResources>;
    lifecycle = new LatestSessionLifecycle<string, FakeResources>({
      cleanup: (session, authority) => {
        const name = session.value.value.name;
        exact.push(`${name}:first`);
        if (name === "A") {
          const reservation = lifecycle.reserve("h2r", { name: "C", handles: [] });
          expect(reservation.kind).toBe("reserved");
          if (reservation.kind === "reserved") {
            third = reservation.session;
            expect(lifecycle.start(reservation.session, () => {})).toBe("started");
          }
        }
        if (authority.isHandoffCurrent()) shared.push(name);
        exact.push(`${name}:last`);
      },
    });
    const first = lifecycle.reserve("h2r", { name: "A", handles: [] });
    if (first.kind !== "reserved") throw new Error("A reservation failed");
    lifecycle.start(first.session, () => {});
    const second = lifecycle.reserve("h2r", { name: "B", handles: [] });
    if (second.kind !== "reserved") throw new Error("B reservation failed");
    secondSession = second.session;

    expect(lifecycle.start(second.session, () => { secondSetups += 1; })).toBe("superseded");
    expect(lifecycle.current?.value.value.name).toBe("C");
    expect(third && lifecycle.isActive(third)).toBe(true);
    expect(secondSetups).toBe(0);
    expect(exact).toEqual(["A:first", "B:first", "B:last", "A:last"]);
    expect(shared).toEqual(["B"]);
    expect(lifecycle.stop(first.session)).toBe("stale");
    expect(lifecycle.stop(secondSession)).toBe("stale");
    expect(lifecycle.current).toBe(third);
    expect(lifecycle.stop(third!)).toBe("stopped");
    expect(exact.slice(-2)).toEqual(["C:first", "C:last"]);
  });

  it("exposes terminal cleanup lineage before a reentrant successor reserves", () => {
    interface OrbitResources extends FakeResources {
      readonly orbitBaseline: boolean;
    }
    type OrbitSession = SessionLifecycleLease<string, OrbitResources>;
    let orbitEnabled = true;
    let successor: OrbitSession | null = null;
    let lifecycle: LatestSessionLifecycle<string, OrbitResources>;
    lifecycle = new LatestSessionLifecycle({
      cleanup: (session, authority) => {
        if (session.value.value.name !== "A") return;
        expect(lifecycle.current).toBeNull();
        expect(lifecycle.currentCleanup).toBe(session);
        const lineage = lifecycle.current ?? lifecycle.currentCleanup;
        const reservation = lifecycle.reserve("h2r", {
          name: "C",
          handles: [],
          orbitBaseline: lineage?.value.value.orbitBaseline ?? orbitEnabled,
        });
        if (reservation.kind !== "reserved") throw new Error("C reservation failed");
        successor = reservation.session;
        lifecycle.start(reservation.session, (owned) => {
          orbitEnabled = owned.value.value.orbitBaseline;
        });
        // A no longer owns shared projection after C is published.
        if (authority.isHandoffCurrent()) orbitEnabled = session.value.value.orbitBaseline;
      },
    });
    const first = lifecycle.reserve("h2r", {
      name: "A",
      handles: [],
      orbitBaseline: true,
    });
    if (first.kind !== "reserved") throw new Error("A reservation failed");
    lifecycle.start(first.session, () => {});
    // A's active pointer gesture temporarily disables the shared orbit.
    orbitEnabled = false;

    expect(lifecycle.stop(first.session)).toBe("stopped");
    expect(successor && lifecycle.isActive(successor)).toBe(true);
    expect(orbitEnabled).toBe(true);
    expect(lifecycle.currentCleanup).toBeNull();
  });

  it("preserves reentrant C when retired A throws after starting it", () => {
    let successor: FakeSession | null = null;
    let lifecycle: LatestSessionLifecycle<string, FakeResources>;
    lifecycle = new LatestSessionLifecycle({
      cleanup: (session) => {
        if (session.value.value.name !== "A") return;
        const reservation = lifecycle.reserve("h2r", { name: "C", handles: [] });
        if (reservation.kind !== "reserved") throw new Error("C reservation failed");
        successor = reservation.session;
        lifecycle.start(reservation.session, () => {});
        throw new Error("A-late-cleanup");
      },
    });
    const first = lifecycle.reserve("h2r", { name: "A", handles: [] });
    if (first.kind !== "reserved") throw new Error("A reservation failed");
    lifecycle.start(first.session, () => {});

    expect(() => lifecycle.stop(first.session)).toThrowError(
      expect.objectContaining({
        errors: [expect.objectContaining({ message: "A-late-cleanup" })],
      }),
    );
    expect(successor && lifecycle.isActive(successor)).toBe(true);
    expect(first.session.value.phase).toBe("stopped");
    expect(lifecycle.current).toBe(successor);
    expect(lifecycle.currentCleanup).toBeNull();
    expect(lifecycle.stop(successor!)).toBe("stopped");
  });

  it("stops B reentrantly during setup and does not run the next setup step", () => {
    const releases: string[] = [];
    const lifecycle = new LatestSessionLifecycle<string, FakeResources>({
      cleanup: (session) => {
        const handles = session.value.value.handles.splice(0);
        for (const handle of handles) releases.push(handle);
      },
    });
    const reservation = lifecycle.reserve("h2r", {
      name: "B",
      handles: [],
    });
    if (reservation.kind !== "reserved") throw new Error("B reservation failed");

    const result = lifecycle.start(reservation.session, (session, authority) => {
      session.value.value.handles.push("listener-B");
      lifecycle.stop(session);
      if (!authority.isCurrent()) return;
      session.value.value.handles.push("must-not-install");
    });

    expect(result).toBe("superseded");
    expect(releases).toEqual(["listener-B"]);
    expect(reservation.session.value.value.handles).toEqual([]);
  });

  it("treats stop(A) as a no-op after B is reserved", () => {
    const cleaned: string[] = [];
    const lifecycle = new LatestSessionLifecycle<string, FakeResources>({
      cleanup: (session) => cleaned.push(session.value.value.name),
    });
    const first = lifecycle.reserve("h2r", { name: "A", handles: [] });
    if (first.kind !== "reserved") throw new Error("A reservation failed");
    lifecycle.start(first.session, () => {});
    const second = lifecycle.reserve("h2r", { name: "B", handles: [] });
    if (second.kind !== "reserved") throw new Error("B reservation failed");

    expect(lifecycle.stop(first.session)).toBe("stale");
    expect(cleaned).toEqual([]);
    expect(lifecycle.current).toBe(second.session);
  });

  it("rejects a cross-workflow reservation without mutation", () => {
    const lifecycle = new LatestSessionLifecycle<string, FakeResources>({
      cleanup: () => {},
    });
    const first = lifecycle.reserve("h2r", { name: "A", handles: [] });
    if (first.kind !== "reserved") throw new Error("A reservation failed");
    lifecycle.start(first.session, () => {});
    const phase = first.session.value.phase;

    const busy = lifecycle.reserve("r2r", { name: "B", handles: [] });

    expect(busy).toEqual({ kind: "busy", owner: "h2r" });
    expect(lifecycle.current).toBe(first.session);
    expect(first.session.value.phase).toBe(phase);
    expect(lifecycle.isActive(first.session)).toBe(true);
  });

  it("keeps cross-workflow reserve busy during terminal cleanup", () => {
    let nested: ReturnType<LatestSessionLifecycle<string, FakeResources>["reserve"]>
      | null = null;
    let lifecycle: LatestSessionLifecycle<string, FakeResources>;
    lifecycle = new LatestSessionLifecycle({
      cleanup: (session) => {
        if (session.value.value.name === "A") {
          expect(lifecycle.current).toBeNull();
          nested = lifecycle.reserve("r2r", { name: "R", handles: [] });
        }
      },
    });
    const first = lifecycle.reserve("h2r", { name: "A", handles: [] });
    if (first.kind !== "reserved") throw new Error("A reservation failed");
    lifecycle.start(first.session, () => {});

    expect(lifecycle.stop(first.session)).toBe("stopped");
    expect(nested).toEqual({ kind: "busy", owner: "h2r" });
    const afterCleanup = lifecycle.reserve("r2r", { name: "R", handles: [] });
    expect(afterCleanup.kind).toBe("reserved");
  });

  it("skips setup, drains B, and flattens predecessor cleanup errors", () => {
    const visited: string[] = [];
    let setupCalls = 0;
    const lifecycle = new LatestSessionLifecycle<string, FakeResources>({
      cleanup: (session) => {
        const name = session.value.value.name;
        visited.push(name);
        if (name === "A") {
          throw new AggregateError([new Error("A-1"), new Error("A-2")]);
        }
        if (name === "B") throw new Error("B-1");
      },
    });
    const first = lifecycle.reserve("h2r", { name: "A", handles: [] });
    if (first.kind !== "reserved") throw new Error("A reservation failed");
    lifecycle.start(first.session, () => {});
    const second = lifecycle.reserve("h2r", { name: "B", handles: [] });
    if (second.kind !== "reserved") throw new Error("B reservation failed");

    let thrown: unknown;
    try {
      lifecycle.start(second.session, () => {
        setupCalls += 1;
      });
    } catch (error) {
      thrown = error;
    }

    expect(visited).toEqual(["A", "B"]);
    expect(setupCalls).toBe(0);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual(["A-1", "A-2", "B-1"]);
    expect(lifecycle.current).toBeNull();
  });

  it("preserves a lone setup error identity", () => {
    const lifecycle = new LatestSessionLifecycle<string, FakeResources>({
      cleanup: () => {},
    });
    const reservation = lifecycle.reserve("h2r", { name: "A", handles: [] });
    if (reservation.kind !== "reserved") throw new Error("A reservation failed");
    const setupError = new Error("setup");

    let thrown: unknown;
    try {
      lifecycle.start(reservation.session, () => { throw setupError; });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(setupError);
    expect(lifecycle.current).toBeNull();
    expect(lifecycle.stop(reservation.session)).toBe("stale");
  });

  it("does not resurrect B after its setup starts C and then throws", () => {
    let successor: FakeSession | null = null;
    const lifecycle = new LatestSessionLifecycle<string, FakeResources>({
      cleanup: () => {},
    });
    const reservation = lifecycle.reserve("h2r", { name: "B", handles: [] });
    if (reservation.kind !== "reserved") throw new Error("B reservation failed");
    const setupError = new Error("B setup after C");

    expect(() => lifecycle.start(reservation.session, () => {
      const nested = lifecycle.reserve("h2r", { name: "C", handles: [] });
      if (nested.kind !== "reserved") throw new Error("C reservation failed");
      successor = nested.session;
      expect(lifecycle.start(nested.session, () => {})).toBe("started");
      throw setupError;
    })).toThrow(setupError);

    expect(reservation.session.value.phase).toBe("stopped");
    expect(successor && lifecycle.isActive(successor)).toBe(true);
    expect(lifecycle.current).toBe(successor);
    expect(lifecycle.stop(reservation.session)).toBe("stale");
    expect(lifecycle.stop(successor!)).toBe("stopped");
  });

  it("keeps setup first and flattens rollback errors exactly once", () => {
    const lifecycle = new LatestSessionLifecycle<string, FakeResources>({
      cleanup: () => {
        throw new AggregateError([new Error("cleanup-1"), new Error("cleanup-2")]);
      },
    });
    const reservation = lifecycle.reserve("h2r", { name: "A", handles: [] });
    if (reservation.kind !== "reserved") throw new Error("A reservation failed");

    let thrown: unknown;
    try {
      lifecycle.start(reservation.session, () => { throw new Error("setup"); });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual(["setup", "cleanup-1", "cleanup-2"]);
    expect(lifecycle.current).toBeNull();
    expect(lifecycle.stop(reservation.session)).toBe("stale");
  });
});
