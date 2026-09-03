import { describe, expect, it } from "vitest";

import {
  installReentrantSessionResource,
  ReentrantHostMutationGate,
} from
  "../../../src/runtime/stage/reentrant-session-install";

describe("installReentrantSessionResource", () => {
  it("marks before a host stops the session and cleans a returned-late install", () => {
    let current = true;
    let attached = false;
    let releases = 0;
    const order: string[] = [];

    const disposition = installReentrantSessionResource({
      authority: { isCurrent: () => current },
      mark: () => { order.push("mark"); },
      install: () => {
        order.push("host");
        current = false;
        // Ordinary stop ran before this simulated host committed the handle.
        attached = true;
      },
      cleanupLate: (cause) => {
        if (attached) {
          attached = false;
          releases += 1;
        }
        order.push(`late-cleanup:${cause}`);
      },
    });

    expect(disposition).toBe("superseded");
    expect(order).toEqual(["mark", "host", "late-cleanup:returned"]);
    expect(attached).toBe(false);
    expect(releases).toBe(1);
  });

  it("keeps the install error first and flattens threw-late cleanup errors", () => {
    let current = true;
    const installError = new Error("install");
    let thrown: unknown;

    try {
      installReentrantSessionResource({
        authority: { isCurrent: () => current },
        mark: () => {},
        install: () => {
          current = false;
          throw installError;
        },
        cleanupLate: (cause) => {
          expect(cause).toBe("threw");
          throw new AggregateError([
            new Error("cleanup-1"),
            new Error("cleanup-2"),
          ]);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      installError,
      expect.objectContaining({ message: "cleanup-1" }),
      expect.objectContaining({ message: "cleanup-2" }),
    ]);
  });

  it("preserves a current install error identity for owner rollback", () => {
    const installError = new Error("install");

    expect(() => installReentrantSessionResource({
      authority: { isCurrent: () => true },
      mark: () => {},
      install: () => { throw installError; },
      cleanupLate: () => { throw new Error("must not run"); },
    })).toThrow(installError);
  });

  it("does nothing when authority is already stale", () => {
    let calls = 0;
    expect(installReentrantSessionResource({
      authority: { isCurrent: () => false },
      mark: () => { calls += 1; },
      install: () => { calls += 1; },
      cleanupLate: () => { calls += 1; },
    })).toBe("superseded");
    expect(calls).toBe(0);
  });

  it("does not enter the host when mark retires the exact session", () => {
    let current = true;
    let installs = 0;
    let lateCleanups = 0;

    expect(installReentrantSessionResource({
      authority: { isCurrent: () => current },
      mark: () => { current = false; },
      install: () => { installs += 1; },
      cleanupLate: () => { lateCleanups += 1; },
    })).toBe("superseded");
    expect(installs).toBe(0);
    expect(lateCleanups).toBe(0);
  });
});

describe("ReentrantHostMutationGate", () => {
  it("rejects a deferral that has no enclosing host frame to drain it", () => {
    const gate = new ReentrantHostMutationGate();

    expect(() => gate.deferUntilIdle()).toThrow(
      "A host mutation can only be deferred from a reentrant host frame",
    );
  });

  it("installs a reserved successor only after the retired release returns", () => {
    const gate = new ReentrantHostMutationGate();
    const order: string[] = [];
    const installSuccessor = (): void => {
      if (gate.isInsideHostMutation) {
        order.push("reserve-C");
        gate.deferUntilIdle();
        return;
      }
      gate.run(
        () => { order.push("install-C"); },
        installSuccessor,
      );
    };

    gate.run(
      () => {
        order.push("release-A:start");
        installSuccessor();
        order.push("release-A:late-commit");
      },
      installSuccessor,
    );

    expect(order).toEqual([
      "release-A:start",
      "reserve-C",
      "release-A:late-commit",
      "install-C",
    ]);
  });

  it("keeps the retired mutation error before a deferred install error", () => {
    const gate = new ReentrantHostMutationGate();
    const mutationError = new Error("release-A");

    expect(() => gate.run(
      () => {
        gate.deferUntilIdle();
        throw mutationError;
      },
      () => {
        throw new AggregateError([new Error("install-C-1"), new Error("install-C-2")]);
      },
    )).toThrowError(expect.objectContaining({
      errors: [
        mutationError,
        expect.objectContaining({ message: "install-C-1" }),
        expect.objectContaining({ message: "install-C-2" }),
      ],
    }));
  });

  it("still installs the deferred successor when the retired release throws", () => {
    const gate = new ReentrantHostMutationGate();
    const releaseError = new Error("release-A");
    let successorInstalled = false;

    expect(() => gate.run(
      () => {
        gate.deferUntilIdle();
        throw releaseError;
      },
      () => { successorInstalled = true; },
    )).toThrow(releaseError);
    expect(successorInstalled).toBe(true);
  });
});
