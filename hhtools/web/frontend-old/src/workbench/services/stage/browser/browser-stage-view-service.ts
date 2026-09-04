import {
  toDisposable,
  type IDisposable,
} from "@/base/common/disposable";
import type { IStageDisplayCommands } from "../common/stage-service";
import type {
  IStageView,
  IStageViewAttachment,
} from "../common/stage-view";

interface StageViewAttachmentRecord {
  readonly view: IStageView;
}

/**
 * Routes Stage display commands to the one View that owns the live renderer.
 *
 * The service owns only a borrowed reference. A strict single-attachment rule
 * makes accidental overlapping WebGL renderers fail during composition rather
 * than silently replacing one another on the shared canvas.
 */
export class BrowserStageViewService
  implements IStageDisplayCommands, IStageViewAttachment, IDisposable
{
  readonly #reportError: (error: unknown) => void;
  #attachment: StageViewAttachmentRecord | null = null;
  #disposed = false;

  constructor(reportError: (error: unknown) => void) {
    this.#reportError = reportError;
  }

  attachView(view: IStageView): IDisposable {
    if (this.#disposed) throw new Error("Stage view service is disposed");
    if (this.#attachment) {
      throw new Error("A Stage view is already attached");
    }

    // Compare the record rather than only the View. A stale handle from an old
    // attachment can therefore never detach a later registration of the same
    // object.
    const attachment: StageViewAttachmentRecord = { view };
    this.#attachment = attachment;
    return toDisposable(() => {
      if (this.#attachment === attachment) this.#attachment = null;
    });
  }

  resetView(): void {
    if (this.#disposed) return;
    // Snapshot before invoking user code. If A detaches itself and attaches B
    // while handling this command, the current intent still belongs only to A.
    const view = this.#attachment?.view;
    if (!view) return;
    try {
      // Promise.resolve also assimilates an async View implementation without
      // changing the synchronous command API exposed to React and commands.
      void Promise.resolve(view.resetView()).catch((error) =>
        this.#reportSafely(error),
      );
    } catch (error) {
      this.#reportSafely(error);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // The attachment is borrowed: React (or the temporary legacy owner) must
    // release the actual renderer and GPU resources through its own lifecycle.
    this.#attachment = null;
  }

  #reportSafely(error: unknown): void {
    try {
      this.#reportError(error);
    } catch {
      // Error reporting is observational and cannot break later commands.
    }
  }
}
