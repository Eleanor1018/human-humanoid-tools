import type { MotionPayload } from "@/domain/motion/common/motion";
import type { IDisposable } from "@/base/common/disposable";

/**
 * Application-level presentation outcome. A superseded result is a normal
 * cancellation: a newer motion won ownership while an async Stage View loaded.
 */
export type MotionPresentationResult = "presented" | "superseded";

/** User intent captured before inference/import transport begins. */
export interface HumanMotionPresentationIntent {
  readonly label: string;
}

export interface MotionPresentationReservationOptions {
  /** Cancels acquisition until the returned Promise settles. */
  readonly signal?: AbortSignal;
}

/** One-shot latest-only right to commit a generated motion. */
export interface IHumanMotionPresentationReservation extends IDisposable {
  commit(payload: MotionPayload): Promise<MotionPresentationResult>;
}

/**
 * Reserves and commits generated motion to shared application presentation.
 *
 * Reservation happens when user intent begins, before inference or import can
 * yield. Callers see one use-case operation rather than Stage, library, or
 * basket primitives; the browser adapter supplies the temporary runtime owner.
 */
export interface IMotionResultPresentationService {
  reserveHumanMotionPresentation(
    intent: HumanMotionPresentationIntent,
    options?: MotionPresentationReservationOptions,
  ): Promise<IHumanMotionPresentationReservation>;
}
