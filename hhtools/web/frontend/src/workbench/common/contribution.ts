import {
  DisposableStore,
  type IDisposable,
} from "@/base/common/disposable";

/**
 * Monotonic milestones used to keep startup work off the critical render path.
 * Numeric ordering is intentional: advancing across several phases activates
 * every skipped phase in sequence.
 */
export enum WorkbenchLifecyclePhase {
  Starting = 1,
  Ready = 2,
  Restored = 3,
  Eventually = 4,
}

export interface IWorkbenchContributionContext {
  /** Report a contribution failure without preventing sibling activation. */
  reportError(error: unknown): void;
}

/** A feature-owned startup participant registered by the composition root. */
export interface IWorkbenchContribution {
  readonly id: string;
  readonly phase: WorkbenchLifecyclePhase;
  activate(context: IWorkbenchContributionContext): IDisposable;
}

export interface IWorkbenchContributionLifecycle extends IDisposable {
  readonly phase: WorkbenchLifecyclePhase;
  advanceTo(phase: WorkbenchLifecyclePhase): void;
}

const ORDERED_PHASES = [
  WorkbenchLifecyclePhase.Starting,
  WorkbenchLifecyclePhase.Ready,
  WorkbenchLifecyclePhase.Restored,
  WorkbenchLifecyclePhase.Eventually,
] as const;

function isLifecyclePhase(value: number): value is WorkbenchLifecyclePhase {
  return ORDERED_PHASES.includes(value as WorkbenchLifecyclePhase);
}

/**
 * Single owner for Workbench contributions and the service graph beneath them.
 *
 * Contributions activate in phase order and registration order within a phase.
 * Their returned resources are released in reverse activation order; the owned
 * service graph, registered first, is therefore always released last.
 */
export class WorkbenchContributionLifecycle
  implements IWorkbenchContributionLifecycle
{
  readonly #owned = new DisposableStore();
  readonly #contributions: readonly IWorkbenchContribution[];
  readonly #onError: (error: unknown) => void;
  readonly #context: IWorkbenchContributionContext;
  #phase = WorkbenchLifecyclePhase.Starting;
  #disposed = false;

  constructor(
    ownedServiceGraph: IDisposable,
    contributions: readonly IWorkbenchContribution[],
    onError: (error: unknown) => void,
  ) {
    const ids = new Set<string>();
    for (const contribution of contributions) {
      if (!contribution.id.trim()) {
        throw new Error("Workbench contribution ids must not be empty");
      }
      if (ids.has(contribution.id)) {
        throw new Error(
          `Duplicate Workbench contribution id: ${contribution.id}`,
        );
      }
      if (!isLifecyclePhase(contribution.phase)) {
        throw new Error(
          `Invalid lifecycle phase for contribution ${contribution.id}`,
        );
      }
      ids.add(contribution.id);
    }

    this.#contributions = [...contributions];
    this.#onError = onError;
    this.#context = {
      reportError: (error) => {
        if (!this.#disposed) this.#onError(error);
      },
    };
    this.#owned.add(ownedServiceGraph);
    this.#activatePhase(WorkbenchLifecyclePhase.Starting);
  }

  get phase(): WorkbenchLifecyclePhase {
    return this.#phase;
  }

  advanceTo(phase: WorkbenchLifecyclePhase): void {
    if (this.#disposed) return;
    if (!isLifecyclePhase(phase)) {
      throw new Error(`Invalid Workbench lifecycle phase: ${phase}`);
    }
    if (phase < this.#phase) {
      throw new Error(
        `Workbench lifecycle cannot move backwards from ${this.#phase} to ${phase}`,
      );
    }

    for (const next of ORDERED_PHASES) {
      if (next <= this.#phase || next > phase) continue;
      this.#phase = next;
      this.#activatePhase(next);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#owned.dispose();
  }

  #activatePhase(phase: WorkbenchLifecyclePhase): void {
    for (const contribution of this.#contributions) {
      if (contribution.phase !== phase) continue;
      try {
        this.#owned.add(contribution.activate(this.#context));
      } catch (error) {
        this.#context.reportError(error);
      }
    }
  }
}
