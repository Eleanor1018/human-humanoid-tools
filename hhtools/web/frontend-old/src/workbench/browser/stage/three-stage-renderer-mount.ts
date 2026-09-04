import type { IDisposable } from "@/base/common/disposable";

/** DOM elements committed and retained by the React Stage View. */
export interface ThreeStageDomReferences {
  readonly stage: HTMLElement;
  readonly canvas: HTMLCanvasElement;
}

/**
 * Browser-local composition seam between React and a Stage renderer owner.
 *
 * Every mount call must create a fresh owner and synchronously return its
 * lifetime lease. If setup continues asynchronously, that work must already
 * be cancellable through the returned lease. A mount that throws before
 * returning must roll back its own partial setup. A lease may throw only after
 * it has made a terminal, best-effort release of everything it owns.
 *
 * The React seam reports synchronous mount/dispose failures, so implementations
 * must not report those errors before rethrowing them. Work that fails after a
 * lease has already been returned has no React call frame to report through;
 * the implementation owns reporting those asynchronous failures itself.
 *
 * The composition root must keep this object's identity stable. Replacing the
 * object intentionally tells React to dispose the old owner and mount a new
 * one against the same DOM references.
 */
export interface ThreeStageRendererMount {
  mount(dom: ThreeStageDomReferences): IDisposable;
  reportError(error: unknown): void;
}
