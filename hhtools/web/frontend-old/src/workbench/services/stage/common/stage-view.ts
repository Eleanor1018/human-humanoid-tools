import type { IDisposable } from "@/base/common/disposable";
/**
 * Commands implemented by the View that currently owns the Stage renderer.
 *
 * This contract deliberately contains no DOM or Three.js objects. React owns
 * the concrete renderer lifetime; other workbench features can only address
 * the mounted View through semantic commands.
 */
export interface IStageView {
  /** Completion is observed by the attachment service's single error owner. */
  resetView(): void | Promise<void>;
}

/**
 * Composition-only capability for registering the current Stage View.
 *
 * Disposing the returned handle detaches the borrowed reference. It never
 * disposes the View itself, because that resource remains owned by React.
 */
export interface IStageViewAttachment {
  attachView(view: IStageView): IDisposable;
}
