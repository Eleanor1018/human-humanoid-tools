import {
  LatestSessionOwner,
  type OwnedSession,
  type SessionHandoff,
} from "./latest-session-owner";

export type SessionLifecyclePhase =
  | "reserved"
  | "starting"
  | "active"
  | "retired"
  | "stopped";

type SessionCleanupState = "pending" | "running" | "done";

export interface SessionLifecycleRecord<Owner, Value> {
  readonly owner: Owner;
  readonly value: Value;
  phase: SessionLifecyclePhase;
  cleanupState: SessionCleanupState;
  predecessor: SessionLifecycleLease<Owner, Value> | null;
  reservationHandoff: SessionHandoff<SessionLifecycleRecord<Owner, Value>> | null;
}

export type SessionLifecycleLease<Owner, Value> = OwnedSession<
  SessionLifecycleRecord<Owner, Value>
>;

export type SessionReservation<Owner, Value> =
  | {
      readonly kind: "reserved";
      readonly session: SessionLifecycleLease<Owner, Value>;
    }
  | {
      readonly kind: "busy";
      readonly owner: Owner;
    };

export type SessionStartDisposition = "started" | "superseded";
export type SessionStopDisposition = "stopped" | "stale";

export interface SessionCleanupAuthority {
  /** Shared projection is safe only while the initiating handoff still owns it. */
  isHandoffCurrent(): boolean;
}

export interface SessionSetupAuthority {
  /** Recheck after every host boundary before publishing or starting more work. */
  isCurrent(): boolean;
}

export type SessionResourceCleanup<Owner, Value> = (
  session: SessionLifecycleLease<Owner, Value>,
  authority: SessionCleanupAuthority,
) => void;

function appendLifecycleError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendLifecycleError(errors, nested);
    return;
  }
  errors.push(error);
}

/**
 * Coordinates one latest outer session and its predecessor cleanup obligation.
 *
 * Reservation is callback-free, so callers can publish the returned lease
 * before `start` reaches DOM, renderer, or other reentrant host code. Exact
 * resource cleanup stays injected: this module owns temporal authority and
 * cleanup order without depending on a browser implementation.
 */
export class LatestSessionLifecycle<Owner, Value> {
  readonly #sessions = new LatestSessionOwner<
    SessionLifecycleRecord<Owner, Value>
  >();
  readonly #cleanup: SessionResourceCleanup<Owner, Value>;
  readonly #cleanupStack: SessionLifecycleLease<Owner, Value>[] = [];

  constructor({
    cleanup,
  }: {
    readonly cleanup: SessionResourceCleanup<Owner, Value>;
  }) {
    this.#cleanup = cleanup;
  }

  get current(): SessionLifecycleLease<Owner, Value> | null {
    return this.#sessions.current;
  }

  /** Exact record whose cleanup frame can synchronously reserve a successor. */
  get currentCleanup(): SessionLifecycleLease<Owner, Value> | null {
    return this.#cleanupStack.at(-1) ?? null;
  }

  /**
   * Reserve synchronously; a different owner remains wholly untouched.
   * Owner identity uses `Object.is` so reservation cannot invoke user code.
   */
  reserve(owner: Owner, value: Value): SessionReservation<Owner, Value> {
    const previous = this.#sessions.current;
    // Terminal stop publishes current=null before cleanup. Keep a retiring
    // workflow as the ownership barrier until its exact resources are drained;
    // same-owner reentry is allowed, cross-owner reentry remains busy.
    const occupied = previous ?? this.currentCleanup;
    if (occupied && !Object.is(occupied.value.owner, owner)) {
      return Object.freeze({ kind: "busy", owner: occupied.value.owner });
    }

    const record: SessionLifecycleRecord<Owner, Value> = {
      owner,
      value,
      phase: "reserved",
      cleanupState: "pending",
      predecessor: previous,
      reservationHandoff: null,
    };
    if (previous) previous.value.phase = "retired";
    const replacement = this.#sessions.begin(record);
    record.reservationHandoff = replacement.handoff;
    return Object.freeze({ kind: "reserved", session: replacement.current });
  }

  start(
    session: SessionLifecycleLease<Owner, Value>,
    setup: (
      session: SessionLifecycleLease<Owner, Value>,
      authority: SessionSetupAuthority,
    ) => void,
  ): SessionStartDisposition {
    const record = session.value;
    if (!this.#sessions.isCurrent(session) || record.phase !== "reserved") {
      return "superseded";
    }
    record.phase = "starting";
    const reservationHandoff = record.reservationHandoff;
    if (!reservationHandoff) {
      throw new Error("Reserved session is missing its ownership handoff");
    }

    const predecessorErrors: unknown[] = [];
    this.#cleanupChain(record.predecessor, reservationHandoff, predecessorErrors);
    if (predecessorErrors.length > 0) {
      const handoff = this.#sessions.finish(session) ?? reservationHandoff;
      if (record.cleanupState !== "done") record.phase = "retired";
      this.#cleanupChain(session, handoff, predecessorErrors);
      throw new AggregateError(
        predecessorErrors,
        "Session predecessor cleanup failed and start was rolled back",
      );
    }
    if (!this.#isStarting(session)) return "superseded";

    const authority: SessionSetupAuthority = {
      isCurrent: () => this.#isStarting(session),
    };
    try {
      setup(session, authority);
    } catch (setupError) {
      const errors: unknown[] = [];
      appendLifecycleError(errors, setupError);
      const setupErrorCount = errors.length;
      const handoff = this.#sessions.finish(session) ?? reservationHandoff;
      if (record.cleanupState !== "done") record.phase = "retired";
      this.#cleanupChain(session, handoff, errors);
      if (errors.length > setupErrorCount) {
        throw new AggregateError(
          errors,
          "Session setup failed and rollback was incomplete",
        );
      }
      throw setupError;
    }

    if (!this.#isStarting(session)) return "superseded";
    record.phase = "active";
    return "started";
  }

  stop(session: SessionLifecycleLease<Owner, Value>): SessionStopDisposition {
    const handoff = this.#sessions.finish(session);
    if (!handoff) return "stale";

    session.value.phase = "retired";
    const errors: unknown[] = [];
    this.#cleanupChain(session, handoff, errors);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Session cleanup failed");
    }
    return "stopped";
  }

  isCurrent(session: SessionLifecycleLease<Owner, Value>): boolean {
    return this.#sessions.isCurrent(session);
  }

  isActive(session: SessionLifecycleLease<Owner, Value>): boolean {
    return this.#sessions.isCurrent(session) && session.value.phase === "active";
  }

  #isStarting(session: SessionLifecycleLease<Owner, Value>): boolean {
    return this.#sessions.isCurrent(session) && session.value.phase === "starting";
  }

  #cleanupChain(
    session: SessionLifecycleLease<Owner, Value> | null,
    handoff: SessionHandoff<SessionLifecycleRecord<Owner, Value>>,
    errors: unknown[],
  ): void {
    if (!session) return;
    const record = session.value;
    if (record.cleanupState !== "pending") return;

    this.#cleanupChain(record.predecessor, handoff, errors);
    // A nested successor may have drained this record while its predecessor
    // was running. Recheck before taking its resources a second time.
    if (record.cleanupState !== "pending") return;

    record.cleanupState = "running";
    record.phase = "retired";
    const authority: SessionCleanupAuthority = {
      isHandoffCurrent: () => this.#sessions.isHandoffCurrent(handoff),
    };
    this.#cleanupStack.push(session);
    try {
      this.#cleanup(session, authority);
    } catch (error) {
      appendLifecycleError(errors, error);
    } finally {
      this.#cleanupStack.pop();
      record.predecessor = null;
      record.cleanupState = "done";
      record.phase = "stopped";
    }
  }
}
