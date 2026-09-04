export type AsyncFrameCallback = (timeMilliseconds: number) => void;

export interface AsyncFrameScheduler {
  requestFrame(callback: AsyncFrameCallback): number;
  cancelFrame(handle: number): void;
}

export interface CoalescedAsyncFrameTaskOptions<Result> {
  readonly scheduler: AsyncFrameScheduler;
  readonly execute: () => Promise<Result>;
  readonly commit: (result: Result) => void;
  readonly reportError: (error: unknown) => void;
}

interface ScheduledFrame {
  handle: number | null;
  callbackStarted: boolean;
  cancelWhenAssigned: boolean;
}

interface TaskSession {
  readonly generation: number;
  scheduledFrame: ScheduledFrame | null;
  inFlight: boolean;
  queued: boolean;
}

/**
 * Owns one generation of frame-coalesced asynchronous work.
 *
 * The execute Promise is intentionally not assumed to be cancellable. Stopping
 * takes the whole session record before cancelling its frame, so an escaped RAF
 * callback or late Promise settlement cannot publish into a replacement session.
 */
export class CoalescedAsyncFrameTask<Result> {
  readonly #scheduler: AsyncFrameScheduler;
  readonly #execute: () => Promise<Result>;
  readonly #commit: (result: Result) => void;
  readonly #reportError: (error: unknown) => void;

  #generation = 0;
  #session: TaskSession | null = null;

  constructor(options: CoalescedAsyncFrameTaskOptions<Result>) {
    this.#scheduler = options.scheduler;
    this.#execute = options.execute;
    this.#commit = options.commit;
    this.#reportError = options.reportError;
  }

  /** Begin a fresh owner generation; any previous generation becomes terminal. */
  start(): void {
    const previous = this.#session;
    const session: TaskSession = {
      generation: ++this.#generation,
      scheduledFrame: null,
      inFlight: false,
      queued: false,
    };
    // Publish the replacement before foreign cancellation code runs. If that
    // code re-enters start/stop, its later ownership decision must win.
    this.#session = session;
    if (previous) this.#terminalizeSession(previous);
  }

  /**
   * Terminalize the current generation before interacting with the scheduler.
   * Promise completion needs no cancellation support because it retains only the
   * detached session record and must pass an identity check before every effect.
   */
  stop(): void {
    this.#generation += 1;
    const session = this.#session;
    this.#session = null;
    if (!session) return;
    this.#terminalizeSession(session);
  }

  /** Coalesce repeated requests into the next owned animation frame. */
  schedule(): void {
    const session = this.#session;
    if (!session) return;
    if (session.inFlight) {
      session.queued = true;
      return;
    }
    this.#scheduleFrame(session);
  }

  /** Cancel a pending frame and request the current state immediately. */
  flush(): void {
    const session = this.#session;
    if (!session) return;

    const scheduledFrame = session.scheduledFrame;
    session.scheduledFrame = null;
    if (scheduledFrame) this.#cancelScheduledFrame(scheduledFrame);
    this.#beginExecution(session);
  }

  #scheduleFrame(session: TaskSession): void {
    if (!this.#isCurrent(session) || session.scheduledFrame) return;

    const scheduledFrame: ScheduledFrame = {
      handle: null,
      callbackStarted: false,
      cancelWhenAssigned: false,
    };
    session.scheduledFrame = scheduledFrame;

    try {
      const handle = this.#scheduler.requestFrame(() => {
        scheduledFrame.callbackStarted = true;
        if (
          !this.#isCurrent(session)
          || session.scheduledFrame !== scheduledFrame
        ) return;

        session.scheduledFrame = null;
        this.#beginExecution(session);
      });
      scheduledFrame.handle = handle;

      // A test host or scheduler adapter may re-enter stop/flush while assigning
      // the handle. Honour that terminal decision once the handle becomes known.
      if (scheduledFrame.cancelWhenAssigned && !scheduledFrame.callbackStarted) {
        this.#cancelFrameSafely(handle);
      }
    } catch (error) {
      if (session.scheduledFrame === scheduledFrame) {
        session.scheduledFrame = null;
      }
      this.#reportCurrentError(session, error);
    }
  }

  #cancelScheduledFrame(scheduledFrame: ScheduledFrame): void {
    if (scheduledFrame.callbackStarted) return;
    if (scheduledFrame.handle === null) {
      scheduledFrame.cancelWhenAssigned = true;
      return;
    }
    this.#cancelFrameSafely(scheduledFrame.handle);
  }

  #terminalizeSession(session: TaskSession): void {
    session.queued = false;
    const scheduledFrame = session.scheduledFrame;
    session.scheduledFrame = null;
    if (scheduledFrame) this.#cancelScheduledFrame(scheduledFrame);
  }

  #cancelFrameSafely(handle: number): void {
    try {
      this.#scheduler.cancelFrame(handle);
    } catch {
      // Cancellation is best-effort; detached frame identity is the terminal
      // guarantee and must not prevent the caller's remaining teardown.
    }
  }

  #beginExecution(session: TaskSession): void {
    if (!this.#isCurrent(session)) return;
    if (session.inFlight) {
      session.queued = true;
      return;
    }

    session.inFlight = true;
    session.queued = false;
    void this.#executeGeneration(session);
  }

  async #executeGeneration(session: TaskSession): Promise<void> {
    try {
      const result = await this.#execute();
      if (!this.#isCurrent(session)) return;
      this.#commit(result);
    } catch (error) {
      this.#reportCurrentError(session, error);
    } finally {
      // Never let an old generation release or schedule work for its successor.
      if (!this.#isCurrent(session)) return;
      session.inFlight = false;
      if (!session.queued) return;
      session.queued = false;
      this.#scheduleFrame(session);
    }
  }

  #isCurrent(session: TaskSession): boolean {
    return (
      this.#session === session
      && this.#generation === session.generation
    );
  }

  #reportCurrentError(session: TaskSession, error: unknown): void {
    if (!this.#isCurrent(session)) return;
    try {
      this.#reportError(error);
    } catch {
      // Error reporting is a diagnostic boundary, never a second async failure.
    }
  }
}
