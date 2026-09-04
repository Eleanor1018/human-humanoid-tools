import {
  DisposableStore,
  toDisposable,
  type IDisposable,
} from "@/base/common/disposable";
import type {
  IStageView,
  IStageViewAttachment,
} from "@/workbench/services/stage/common/stage-view";

import type {
  ThreeStageDomReferences,
  ThreeStageRendererMount,
} from "./three-stage-renderer-mount";

/**
 * An inert renderer owner whose expensive resources are acquired by start().
 * dispose() must make an in-progress start terminal: start may not reacquire
 * anything after a re-entrant disposal returns.
 */
export interface StartableThreeStageRenderer extends IStageView, IDisposable {
  start(): void;
}

/**
 * Creates an inert renderer for one committed React Stage surface.
 *
 * The factory must not allocate WebGL resources, schedule work, or install
 * listeners. Those operations belong exclusively to the returned owner's
 * start() method, after the single-View attachment guard has succeeded.
 * Every call must return a fresh owner. Construction failures must roll back
 * any partial work before throwing.
 */
export type ThreeStageRendererFactory = (
  dom: ThreeStageDomReferences,
) => StartableThreeStageRenderer;

/**
 * Loads renderer code without starting or allocating a Stage renderer.
 * Dynamic imports used here must therefore be free of Stage bootstrap side
 * effects; resolving the promise only makes an inert factory available.
 */
export interface ThreeStageRendererFactoryLoader {
  load(): Promise<ThreeStageRendererFactory>;
}

export interface LazyThreeStageRendererMountOptions {
  readonly loader: ThreeStageRendererFactoryLoader;
  readonly stageViewAttachment: IStageViewAttachment;
  readonly reportError: (error: unknown) => void;
}

interface RendererMountRecord {
  disposed: boolean;
  lifetime: DisposableStore | null;
}

function withCleanupError(
  primary: unknown,
  cleanup: unknown,
): AggregateError {
  const errors = [primary];
  if (cleanup instanceof AggregateError) errors.push(...cleanup.errors);
  else errors.push(cleanup);
  return new AggregateError(
    errors,
    "Stage renderer activation failed and rollback was incomplete",
  );
}

/**
 * Bridges React's synchronous effect lease to a lazily loaded renderer.
 *
 * Attachment intentionally precedes start(): the Stage command router is the
 * last inexpensive single-owner guard before a renderer may allocate the one
 * WebGL context for the shared canvas. The local store is registered before
 * every foreign call, so teardown also wins factory/attach/start re-entrancy.
 */
export class LazyThreeStageRendererMount implements ThreeStageRendererMount {
  readonly #loader: ThreeStageRendererFactoryLoader;
  readonly #stageViewAttachment: IStageViewAttachment;
  readonly #reportError: (error: unknown) => void;
  #active: RendererMountRecord | null = null;

  constructor(options: LazyThreeStageRendererMountOptions) {
    this.#loader = options.loader;
    this.#stageViewAttachment = options.stageViewAttachment;
    this.#reportError = options.reportError;
  }

  mount(dom: ThreeStageDomReferences): IDisposable {
    if (this.#active) {
      throw new Error("A Stage renderer mount is already active");
    }

    const record: RendererMountRecord = {
      disposed: false,
      lifetime: null,
    };
    this.#active = record;

    let loading: Promise<ThreeStageRendererFactory>;
    try {
      loading = this.#loader.load();
    } catch (error) {
      // A synchronous loader failure occurs before React receives its lease.
      // Roll back the mount record and let the React seam report the error.
      record.disposed = true;
      this.#active = null;
      throw error;
    }

    // Loading may outlive this React effect. The record identity prevents a
    // stale completion from activating against a later mount of the same DOM.
    void loading.then(
      (factory) => this.#activate(record, dom, factory),
      (error) => {
        // A rejected import happens after mount() returned, so this adapter is
        // its only error owner. Teardown winning the race makes it irrelevant.
        this.#failActivation(record, error);
      },
    );

    return toDisposable(() => this.#disposeRecord(record));
  }

  /** Synchronous mount/cleanup failures are reported here by the React seam. */
  reportError(error: unknown): void {
    this.#reportError(error);
  }

  #activate(
    record: RendererMountRecord,
    dom: ThreeStageDomReferences,
    factory: ThreeStageRendererFactory,
  ): void {
    if (!this.#isActive(record)) return;

    const lifetime = new DisposableStore();
    record.lifetime = lifetime;
    try {
      const renderer = lifetime.add(factory(dom));
      if (!this.#isActive(record)) return;

      // Register the attachment second so reverse disposal always detaches
      // commands before the renderer tears down listeners and GPU resources.
      lifetime.add(this.#stageViewAttachment.attachView(renderer));
      if (!this.#isActive(record)) return;

      renderer.start();
    } catch (error) {
      this.#failActivation(record, error);
    }
  }

  #failActivation(record: RendererMountRecord, error: unknown): void {
    const wasActive = this.#isActive(record);
    if (wasActive) {
      // Failure is terminal for this effect attempt. Release the slot before
      // cleanup/reporting so either foreign path may safely trigger recovery;
      // the stale React lease becomes an idempotent no-op.
      record.disposed = true;
      if (this.#active === record) this.#active = null;
    }

    const lifetime = record.lifetime;
    record.lifetime = null;
    let reportable = error;
    try {
      lifetime?.dispose();
    } catch (cleanupError) {
      reportable = withCleanupError(error, cleanupError);
    }

    // start() can re-enter React and dispose this lease. That cleanup path owns
    // its errors, and the renderer's later cancellation is only stale work.
    if (wasActive) this.#reportAsyncErrorSafely(reportable);
  }

  #disposeRecord(record: RendererMountRecord): void {
    if (record.disposed) return;
    record.disposed = true;
    if (this.#active === record) this.#active = null;

    // Relinquish the reference before disposal so terminal cleanup errors do
    // not leave a half-owned lifetime that a later call could release twice.
    const lifetime = record.lifetime;
    record.lifetime = null;
    lifetime?.dispose();
  }

  #isActive(record: RendererMountRecord): boolean {
    return this.#active === record && !record.disposed;
  }

  #reportAsyncErrorSafely(error: unknown): void {
    try {
      this.#reportError(error);
    } catch {
      // Reporting is observational and cannot turn a handled async failure
      // into an unhandled promise rejection.
    }
  }
}
