import { describe, expect, it } from "vitest";

import {
  LatestSessionOwner,
  type OwnedSession,
  type SessionHandoff,
} from "../../../src/runtime/stage/latest-session-owner";

interface SessionValue {
  readonly name: string;
}

describe("LatestSessionOwner", () => {
  it("publishes B before the caller cleans up A", () => {
    const owner = new LatestSessionOwner<SessionValue>();
    const first = owner.begin({ name: "A" }).current;
    const replacement = owner.begin({ name: "B" });
    const observed: string[] = [];

    const cleanup = (_session: OwnedSession<SessionValue>): void => {
      observed.push(owner.current?.value.name ?? "none");
    };
    cleanup(first);

    expect(observed).toEqual(["B"]);
    expect(replacement.previous).toBe(first);
    expect(owner.current).toBe(replacement.current);
    expect(owner.isHandoffCurrent(replacement.handoff)).toBe(true);
  });

  it("treats a stale finish as a no-op against the successor", () => {
    const owner = new LatestSessionOwner<SessionValue>();
    const first = owner.begin({ name: "A" }).current;
    const replacement = owner.begin({ name: "B" });

    expect(owner.finish(first)).toBeNull();
    expect(owner.current).toBe(replacement.current);
    expect(owner.isHandoffCurrent(replacement.handoff)).toBe(true);
  });

  it("invalidates B handoff when A cleanup reenters with C", () => {
    const owner = new LatestSessionOwner<SessionValue>();
    owner.begin({ name: "A" });
    const replacement = owner.begin({ name: "B" });
    const sharedEffects: string[] = [];

    const runIfCurrent = (
      handoff: SessionHandoff<SessionValue>,
      effect: () => void,
    ): void => {
      if (owner.isHandoffCurrent(handoff)) effect();
    };
    runIfCurrent(replacement.handoff, () => {
      sharedEffects.push("A-first-effect");
      owner.begin({ name: "C" });
    });
    runIfCurrent(replacement.handoff, () => {
      sharedEffects.push("A-stale-effect");
    });

    expect(sharedEffects).toEqual(["A-first-effect"]);
    expect(owner.current?.value.name).toBe("C");
    expect(owner.isHandoffCurrent(replacement.handoff)).toBe(false);
  });

  it("finishes the exact session to a current null handoff", () => {
    const owner = new LatestSessionOwner<SessionValue>();
    const session = owner.begin({ name: "A" }).current;
    const handoff = owner.finish(session);

    expect(handoff).not.toBeNull();
    expect(handoff?.current).toBeNull();
    expect(owner.current).toBeNull();
    expect(owner.isHandoffCurrent(handoff!)).toBe(true);
    expect(owner.finish(session)).toBeNull();
  });

  it("preserves the exact session value identity", () => {
    const owner = new LatestSessionOwner<SessionValue>();
    const value = { name: "A" };
    const first = owner.begin(value).current;
    const second = owner.begin(value).current;

    expect(first.value).toBe(value);
    expect(second.value).toBe(value);
    expect(second).not.toBe(first);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(owner.isCurrent(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(true);
  });
});
