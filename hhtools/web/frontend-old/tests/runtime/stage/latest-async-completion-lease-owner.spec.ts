import { describe, expect, it } from "vitest";

import { LatestAsyncCompletionLeaseOwner } from "../../../src/runtime/stage/latest-async-completion-lease-owner";

interface Identity {
  readonly name: string;
}

describe("LatestAsyncCompletionLeaseOwner", () => {
  it("lets only the latest inverse-order attempt finish", () => {
    const owner = new LatestAsyncCompletionLeaseOwner<Identity>(() => true);
    const first = owner.begin({ name: "A" });
    const second = owner.begin({ name: "B" });

    expect(owner.finish(first)).toBe(false);
    expect(owner.leaseIsLatest(first)).toBe(false);
    expect(owner.finish(second)).toBe(true);
    expect(owner.leaseIsLatest(second)).toBe(true);
    expect(owner.isPending).toBe(false);
  });

  it("retains one completion lease until a successor begins", () => {
    const owner = new LatestAsyncCompletionLeaseOwner<Identity>(() => true);
    const first = owner.begin({ name: "A" });
    expect(owner.isPending).toBe(true);
    expect(owner.finish(first)).toBe(true);
    expect(owner.leaseIsLatest(first)).toBe(true);

    const second = owner.begin({ name: "B" });

    expect(owner.leaseIsLatest(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(true);
    expect(owner.isPending).toBe(true);
  });

  it("invalidates an active attempt and its retained completion", () => {
    const owner = new LatestAsyncCompletionLeaseOwner<Identity>(() => true);
    const active = owner.begin({ name: "active" });
    owner.invalidate();
    expect(owner.isCurrent(active)).toBe(false);
    expect(owner.isPending).toBe(false);

    const completed = owner.begin({ name: "completed" });
    expect(owner.finish(completed)).toBe(true);
    owner.invalidate();

    expect(owner.leaseIsLatest(completed)).toBe(false);
    expect(owner.isPending).toBe(false);
  });

  it("abandons only its exact active attempt", () => {
    const owner = new LatestAsyncCompletionLeaseOwner<Identity>(() => true);
    const first = owner.begin({ name: "A" });
    const second = owner.begin({ name: "B" });

    expect(owner.abandon(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(true);
    expect(owner.abandon(second)).toBe(true);
    expect(owner.abandon(second)).toBe(false);
    expect(owner.isPending).toBe(false);
  });

  it("does not let post-finish abandon revoke stable completion", () => {
    const owner = new LatestAsyncCompletionLeaseOwner<Identity>(() => true);
    const attempt = owner.begin({ name: "A" });
    expect(owner.finish(attempt)).toBe(true);

    expect(owner.abandon(attempt)).toBe(false);
    expect(owner.leaseIsLatest(attempt)).toBe(true);
  });

  it("fails closed when mutable identity changes", () => {
    let activeName = "A";
    const owner = new LatestAsyncCompletionLeaseOwner<Identity>(
      (identity) => identity.name === activeName,
    );
    const attempt = owner.begin({ name: "A" });
    activeName = "B";

    expect(owner.isCurrent(attempt)).toBe(false);
    expect(owner.isPending).toBe(false);
    expect(owner.finish(attempt)).toBe(false);
    expect(owner.owns(attempt)).toBe(true);
    expect(owner.abandon(attempt)).toBe(true);
  });

  it("revokes a finished lease when its mutable identity changes", () => {
    let activeName = "A";
    const owner = new LatestAsyncCompletionLeaseOwner<Identity>(
      (identity) => identity.name === activeName,
    );
    const attempt = owner.begin({ name: "A" });
    expect(owner.finish(attempt)).toBe(true);
    activeName = "B";

    expect(owner.leaseIsLatest(attempt)).toBe(false);
  });

  it("rejects a finish superseded inside identity validation", () => {
    let owner!: LatestAsyncCompletionLeaseOwner<Identity>;
    let successor: ReturnType<typeof owner.begin> | null = null;
    owner = new LatestAsyncCompletionLeaseOwner((identity) => {
      if (identity.name === "A") successor = owner.begin({ name: "B" });
      return true;
    });
    const first = owner.begin({ name: "A" });

    expect(owner.finish(first)).toBe(false);
    expect(successor).not.toBeNull();
    expect(owner.isCurrent(successor!)).toBe(true);
    expect(owner.leaseIsLatest(first)).toBe(false);
  });

  it("reports a successor begun inside pending validation as pending", () => {
    let owner!: LatestAsyncCompletionLeaseOwner<Identity>;
    let reenter = true;
    let successor: ReturnType<typeof owner.begin> | null = null;
    owner = new LatestAsyncCompletionLeaseOwner((identity) => {
      if (reenter && identity.name === "A") {
        reenter = false;
        successor = owner.begin({ name: "B" });
      }
      return true;
    });
    owner.begin({ name: "A" });

    expect(owner.isPending).toBe(true);
    expect(successor).not.toBeNull();
    expect(owner.isCurrent(successor!)).toBe(true);
  });

  it("reports explicit invalidation inside pending validation as idle", () => {
    let owner!: LatestAsyncCompletionLeaseOwner<Identity>;
    owner = new LatestAsyncCompletionLeaseOwner(() => {
      owner.invalidate();
      return true;
    });
    owner.begin({ name: "A" });

    expect(owner.isPending).toBe(false);
  });

  it("rejects a finished lease superseded inside identity validation", () => {
    let owner!: LatestAsyncCompletionLeaseOwner<Identity>;
    let reenter = false;
    let successor: ReturnType<typeof owner.begin> | null = null;
    owner = new LatestAsyncCompletionLeaseOwner((identity) => {
      if (reenter && identity.name === "A") {
        successor = owner.begin({ name: "B" });
      }
      return true;
    });
    const first = owner.begin({ name: "A" });
    expect(owner.finish(first)).toBe(true);
    reenter = true;

    expect(owner.leaseIsLatest(first)).toBe(false);
    expect(successor).not.toBeNull();
    expect(owner.isCurrent(successor!)).toBe(true);
  });

  it("keeps a successor current when stale cleanup arrives late", () => {
    const owner = new LatestAsyncCompletionLeaseOwner<Identity>(() => true);
    const first = owner.begin({ name: "A" });
    const second = owner.begin({ name: "B" });

    expect(owner.abandon(first)).toBe(false);
    expect(owner.finish(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(true);
    expect(owner.isPending).toBe(true);
  });
});
