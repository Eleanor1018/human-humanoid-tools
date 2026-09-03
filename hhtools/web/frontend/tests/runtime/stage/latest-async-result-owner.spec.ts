import { describe, expect, it } from "vitest";

import {
  LatestAsyncResultOwner,
} from "../../../src/runtime/stage/latest-async-result-owner";

interface Identity {
  readonly name: string;
}

interface ResultValue {
  readonly token: string;
}

describe("LatestAsyncResultOwner", () => {
  it("lets only the latest inverse-order request commit", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const first = owner.begin({ name: "A" });
    const second = owner.begin({ name: "B" });

    expect(owner.commit(first, { token: "old" })).toBeNull();
    const committed = owner.commit(second, { token: "new" });

    expect(committed?.value.token).toBe("new");
    expect(owner.pendingPresentation).toBe(committed);
  });

  it("revokes an unpresented result when a newer request begins", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const first = owner.begin({ name: "A" });
    const committed = owner.commit(first, { token: "A" })!;

    const second = owner.begin({ name: "B" });

    expect(owner.isCommitted(committed)).toBe(false);
    expect(owner.isLatestResult(committed)).toBe(false);
    expect(owner.pendingPresentation).toBeNull();
    expect(owner.isCurrent(second)).toBe(true);
  });

  it("invalidates both an active request and a pending presentation", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const active = owner.begin({ name: "active" });
    owner.invalidate();
    expect(owner.isCurrent(active)).toBe(false);

    const next = owner.begin({ name: "result" });
    const committed = owner.commit(next, { token: "result" })!;
    owner.invalidate();

    expect(owner.isCommitted(committed)).toBe(false);
    expect(owner.isLatestResult(committed)).toBe(false);
    expect(owner.pendingPresentation).toBeNull();
  });

  it("finishes only the exact current failed request", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const first = owner.begin({ name: "A" });
    const second = owner.begin({ name: "B" });

    expect(owner.finish(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(true);
    expect(owner.finish(second)).toBe(true);
    expect(owner.finish(second)).toBe(false);
  });

  it("consumes an exact presentation receipt once", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const attempt = owner.begin({ name: "A" });
    const committed = owner.commit(attempt, { token: "A" })!;

    expect(owner.markPresented(committed)).toBe(true);
    expect(owner.markPresented(committed)).toBe(false);
    expect(owner.isLatestResult(committed)).toBe(true);
    expect(owner.pendingPresentation).toBeNull();
  });

  it("withdraws only presentation while preserving the domain result", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const attempt = owner.begin({ name: "A" });
    const committed = owner.commit(attempt, { token: "A" })!;

    expect(owner.withdrawPresentation(committed)).toBe(true);
    expect(owner.withdrawPresentation(committed)).toBe(false);
    expect(owner.isCommitted(committed)).toBe(false);
    expect(owner.isLatestResult(committed)).toBe(true);
    expect(owner.pendingPresentation).toBeNull();
  });

  it("does not let a stale withdrawal consume its successor", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const firstAttempt = owner.begin({ name: "A" });
    const first = owner.commit(firstAttempt, { token: "A" })!;
    const secondAttempt = owner.begin({ name: "B" });
    const second = owner.commit(secondAttempt, { token: "B" })!;

    expect(owner.withdrawPresentation(first)).toBe(false);
    expect(owner.pendingPresentation).toBe(second);
    expect(owner.withdrawPresentation(second)).toBe(true);
  });

  it("revokes a presented result as soon as its successor begins", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const firstAttempt = owner.begin({ name: "A" });
    const first = owner.commit(firstAttempt, { token: "A" })!;
    expect(owner.markPresented(first)).toBe(true);

    const secondAttempt = owner.begin({ name: "B" });

    expect(owner.isLatestResult(first)).toBe(false);
    expect(owner.isCurrent(secondAttempt)).toBe(true);
  });

  it("does not let a stale receipt consume its successor", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const firstAttempt = owner.begin({ name: "A" });
    const first = owner.commit(firstAttempt, { token: "A" })!;
    const secondAttempt = owner.begin({ name: "B" });
    const second = owner.commit(secondAttempt, { token: "B" })!;

    expect(owner.markPresented(first)).toBe(false);
    expect(owner.pendingPresentation).toBe(second);
    expect(owner.markPresented(second)).toBe(true);
  });

  it("fails closed when the captured identity changes", () => {
    let activeName = "A";
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(
      (identity) => identity.name === activeName,
    );
    const attempt = owner.begin({ name: "A" });
    activeName = "B";

    expect(owner.commit(attempt, { token: "stale" })).toBeNull();
    expect(owner.pendingPresentation).toBeNull();
  });

  it("rejects a commit superseded from inside identity validation", () => {
    let owner!: LatestAsyncResultOwner<Identity, ResultValue>;
    let successor: ReturnType<typeof owner.begin> | null = null;
    owner = new LatestAsyncResultOwner((identity) => {
      if (identity.name === "A") successor = owner.begin({ name: "B" });
      return true;
    });
    const first = owner.begin({ name: "A" });

    expect(owner.commit(first, { token: "A" })).toBeNull();
    expect(successor).not.toBeNull();
    expect(owner.isCurrent(successor!)).toBe(true);
    expect(owner.pendingPresentation).toBeNull();
  });

  it("preserves caller-owned immutable identities and values", () => {
    const owner = new LatestAsyncResultOwner<Identity, ResultValue>(() => true);
    const identity = Object.freeze({ name: "A" });
    const value = Object.freeze({ token: "A" });
    const attempt = owner.begin(identity);
    const committed = owner.commit(attempt, value)!;

    expect(attempt.identity).toBe(identity);
    expect(committed.value).toBe(value);
    expect(Object.isFrozen(committed)).toBe(true);
  });
});
