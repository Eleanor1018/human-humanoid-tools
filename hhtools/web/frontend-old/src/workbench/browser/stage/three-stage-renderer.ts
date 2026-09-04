import type { IDisposable } from "@/base/common/disposable";
import {
  ThreeResourceDisposer,
  type ThreeResourceExtras,
} from "@/platform/graphics/common/three-resource-disposer";
import type { IStageView } from "@/workbench/services/stage/common/stage-view";
import type { Camera, Object3D, Scene } from "three";

import type { ThreeStageDomReferences } from "./three-stage-renderer-mount";

export type { ThreeStageDomReferences } from "./three-stage-renderer-mount";

/**
 * Browser scheduling is injected so lifecycle tests never create WebGL state.
 * requestAnimationFrame follows the browser contract and invokes its callback
 * asynchronously, after returning the acquired handle.
 */
export interface ThreeStageBrowserEnvironment {
  readonly windowTarget: EventTarget;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  createResizeObserver(callback: () => void): {
    observe(target: Element): void;
    disconnect(): void;
  };
  devicePixelRatio(): number;
  now(): number;
  reportError(error: unknown): void;
}

/** Perspective projection fields layered on Three.js's renderable Camera. */
export type ThreeStagePerspectiveCamera = Camera & {
  aspect: number;
  updateProjectionMatrix(): void;
};

export interface ThreeStageRendererBackend {
  readonly domElement: HTMLCanvasElement;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: Object3D, camera: Camera): void;
  dispose(): void;
}

/** The narrow OrbitControls surface owned by this lifecycle boundary. */
export interface ThreeStageControls {
  readonly domElement: HTMLElement | SVGElement | null;
  readonly object: Camera;
  addEventListener(type: "start" | "end", listener: () => void): void;
  removeEventListener(type: "start" | "end", listener: () => void): void;
  update(): unknown;
  dispose(): void;
}

/**
 * Rendering behavior extracted from lifecycle mechanics.
 *
 * A future migration can wrap the existing Three.js objects in this shape.
 * Keeping it structural lets tests exercise ownership without allocating a
 * WebGL context and avoids making the shell responsible for domain updates.
 * The kernel must not schedule its own primary render loop; this owner supplies
 * the sole animation-frame chain for the shared canvas.
 */
export interface ThreeStageRendererKernel {
  readonly scene: Scene;
  readonly camera: ThreeStagePerspectiveCamera;
  readonly renderer: ThreeStageRendererBackend;
  readonly controls: ThreeStageControls;

  /**
   * Stable, non-throwing inventory of owned resources outside `scene`.
   * The kernel registers resources here when it creates them, so teardown can
   * still reach them even if invalidating asynchronous work later fails. It
   * must remove entries that are disposed early or transferred to another
   * owner; the inventory represents only the kernel's current ownership.
   */
  readonly disposalResources: ThreeResourceExtras;
  updateFrame(deltaSeconds: number, nowMilliseconds: number): void;
  resetView(): void | Promise<void>;
  onCanvasWheel(event: WheelEvent): void;
  onControlsStart(nowMilliseconds: number): void;
  onControlsEnd(nowMilliseconds: number): void;

  /**
   * Invalidate asynchronous completions before performing work that may throw,
   * then cancel kernel-owned secondary tasks. The shell separately disposes
   * `disposalResources`, controls, Scene resources, and the renderer itself.
   */
  shutdown(): void;
}

export interface ThreeStageRendererOptions {
  readonly dom: ThreeStageDomReferences;
  readonly browser: ThreeStageBrowserEnvironment;

  /**
   * A successful return transfers the complete kernel lifetime to this shell.
   * If construction throws before returning, the factory must roll back every
   * partial allocation itself because no ownership transfer has occurred.
   */
  readonly createKernel: (
    dom: ThreeStageDomReferences,
  ) => ThreeStageRendererKernel;
  readonly resourceDisposer?: Pick<
    ThreeResourceDisposer,
    "disposeObject3DResources"
  >;
}

type RendererState = "idle" | "starting" | "running" | "failed" | "disposed";
type StartToken = object;

function appendCleanupError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    errors.push(...error.errors);
    return;
  }
  errors.push(error);
}

function withCleanupError(
  primary: unknown,
  cleanup: unknown,
  message: string,
): AggregateError {
  const errors = [primary];
  appendCleanupError(errors, cleanup);
  return new AggregateError(errors, message);
}

function snapshotDisposalResources(
  resources: ThreeResourceExtras,
): ThreeResourceExtras {
  return {
    geometries: resources.geometries
      ? [...resources.geometries]
      : undefined,
    materials: resources.materials ? [...resources.materials] : undefined,
    textures: resources.textures ? [...resources.textures] : undefined,
  };
}

/**
 * View-private owner for one Stage renderer lifetime.
 *
 * This is intentionally an inactive foundation: constructing it installs no
 * listener, observer, animation frame, or Three.js object. Production must not
 * call start() until the legacy renderer has surrendered the shared canvas;
 * running both owners would create a second RAF/WebGL lifetime.
 */
export class ThreeStageRenderer implements IStageView, IDisposable {
  readonly #dom: ThreeStageDomReferences;
  readonly #browser: ThreeStageBrowserEnvironment;
  readonly #createKernel: ThreeStageRendererOptions["createKernel"];
  readonly #resourceDisposer: Pick<
    ThreeResourceDisposer,
    "disposeObject3DResources"
  >;

  #state: RendererState = "idle";
  #startAttempted = false;
  #startToken: StartToken | null = null;
  #kernel: ThreeStageRendererKernel | null = null;
  #resizeObserver: ReturnType<
    ThreeStageBrowserEnvironment["createResizeObserver"]
  > | null = null;
  #animationFrame: number | undefined;
  #animationGeneration = 0;
  #lastFrameTime: number | undefined;
  #appliedPixelRatio: number | undefined;
  #runtimeErrorReported = false;
  #windowResizeRegistered = false;
  #canvasWheelRegistered = false;
  #controlsStartRegistered = false;
  #controlsEndRegistered = false;

  readonly #onWindowResize = (): void => {
    this.#runRuntimeCallback((kernel) => this.#resizeRunning(kernel));
  };

  readonly #onObservedResize = (): void => {
    this.#runRuntimeCallback((kernel) => this.#resizeRunning(kernel));
  };

  readonly #onCanvasWheel = (event: Event): void => {
    this.#runRuntimeCallback((kernel) =>
      kernel.onCanvasWheel(event as WheelEvent),
    );
  };

  readonly #onControlsStart = (): void => {
    this.#runRuntimeCallback((kernel) => {
      const now = this.#browser.now();
      if (!this.#isRunningKernel(kernel)) return;
      kernel.onControlsStart(now);
    });
  };

  readonly #onControlsEnd = (): void => {
    this.#runRuntimeCallback((kernel) => {
      const now = this.#browser.now();
      if (!this.#isRunningKernel(kernel)) return;
      kernel.onControlsEnd(now);
    });
  };

  constructor(options: ThreeStageRendererOptions) {
    this.#dom = options.dom;
    this.#browser = options.browser;
    this.#createKernel = options.createKernel;
    this.#resourceDisposer =
      options.resourceDisposer ?? new ThreeResourceDisposer();
  }

  /**
   * Acquire the complete renderer lifetime exactly once.
   *
   * A failed attempt is terminal as well: rollback may have disposed kernel
   * resources, so silently retrying the same instance would be unsafe.
   */
  start(): void {
    if (this.#state === "disposed") {
      throw new Error("Cannot start a disposed ThreeStageRenderer");
    }
    if (this.#startAttempted) {
      throw new Error("ThreeStageRenderer start has already been attempted");
    }

    this.#startAttempted = true;
    this.#state = "starting";
    const token: StartToken = {};
    this.#startToken = token;

    try {
      const kernel = this.#createKernel(this.#dom);
      // Ownership transfers only after a successful factory return. Assign it
      // before checking cancellation so a dispose during construction cannot
      // strand a late, successfully returned kernel.
      this.#kernel = kernel;
      this.#assertStartActive(token, kernel);
      this.#validateKernelOwnership(token, kernel);

      this.#installStartListener(
        token,
        kernel,
        (installed) => {
          this.#windowResizeRegistered = installed;
        },
        () =>
          this.#browser.windowTarget.addEventListener(
            "resize",
            this.#onWindowResize,
          ),
        () =>
          this.#browser.windowTarget.removeEventListener(
            "resize",
            this.#onWindowResize,
          ),
      );
      this.#installStartListener(
        token,
        kernel,
        (installed) => {
          this.#canvasWheelRegistered = installed;
        },
        () =>
          this.#dom.canvas.addEventListener("wheel", this.#onCanvasWheel, {
            passive: false,
          }),
        () =>
          this.#dom.canvas.removeEventListener("wheel", this.#onCanvasWheel),
      );
      this.#installStartListener(
        token,
        kernel,
        (installed) => {
          this.#controlsStartRegistered = installed;
        },
        () =>
          kernel.controls.addEventListener("start", this.#onControlsStart),
        () =>
          kernel.controls.removeEventListener("start", this.#onControlsStart),
      );
      this.#installStartListener(
        token,
        kernel,
        (installed) => {
          this.#controlsEndRegistered = installed;
        },
        () => kernel.controls.addEventListener("end", this.#onControlsEnd),
        () =>
          kernel.controls.removeEventListener("end", this.#onControlsEnd),
      );

      const observer = this.#browser.createResizeObserver(
        this.#onObservedResize,
      );
      this.#resizeObserver = observer;
      this.#assertStartActive(token, kernel);
      try {
        observer.observe(this.#dom.stage);
      } catch (error) {
        // A re-entrant dispose may already have taken this field. Restore only
        // the late observer acquisition so catch can disconnect it again.
        if (!this.#isStartActive(token, kernel)) {
          this.#resizeObserver = observer;
        }
        throw error;
      }
      if (!this.#isStartActive(token, kernel)) {
        this.#resizeObserver = observer;
      }
      this.#assertStartActive(token, kernel);

      this.#resizeStarting(token, kernel);

      const generation = ++this.#animationGeneration;
      const handle = this.#browser.requestAnimationFrame((now) =>
        this.#renderFrame(generation, now),
      );
      // Store before validating. If dispose won while requestAnimationFrame was
      // executing, rollback can now cancel the otherwise-late handle.
      this.#animationFrame = handle;
      this.#assertStartActive(token, kernel);

      this.#startToken = null;
      this.#state = "running";
    } catch (startError) {
      // TypeScript cannot observe re-entrant dispose calls made by the foreign
      // operations above, so keep the terminal-state check behind a method.
      if (!this.#isDisposed()) this.#state = "failed";
      this.#startToken = null;
      try {
        this.#releaseOwnedResources();
      } catch (cleanupError) {
        throw withCleanupError(
          startError,
          cleanupError,
          "ThreeStageRenderer start failed and rollback was incomplete",
        );
      }
      throw startError;
    }
  }

  /** Route commands only while live; detached or failed Views fail closed. */
  resetView(): void | Promise<void> {
    const kernel = this.#kernel;
    if (this.#state !== "running" || !kernel) return;
    return kernel.resetView();
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#startToken = null;
    this.#releaseOwnedResources();
  }

  #validateKernelOwnership(
    token: StartToken,
    kernel: ThreeStageRendererKernel,
  ): void {
    const rendererCanvas = kernel.renderer.domElement;
    this.#assertStartActive(token, kernel);
    if (rendererCanvas !== this.#dom.canvas) {
      throw new Error("ThreeStageRenderer kernel must own the supplied canvas");
    }

    const controlsElement = kernel.controls.domElement;
    this.#assertStartActive(token, kernel);
    if (controlsElement !== this.#dom.canvas) {
      throw new Error("ThreeStageRenderer controls must own the supplied canvas");
    }

    const controlsCamera = kernel.controls.object;
    this.#assertStartActive(token, kernel);
    if (controlsCamera !== kernel.camera) {
      throw new Error("ThreeStageRenderer controls must own the kernel camera");
    }
  }

  #installStartListener(
    token: StartToken,
    kernel: ThreeStageRendererKernel,
    setInstalled: (installed: boolean) => void,
    install: () => void,
    uninstall: () => void,
  ): void {
    // Mark before foreign code. A target may install its listener and then
    // throw, in which case ordinary rollback still knows what to remove.
    setInstalled(true);
    try {
      install();
    } catch (error) {
      if (!this.#isStartActive(token, kernel)) {
        setInstalled(false);
        throw this.#removeLateListener(error, uninstall);
      }
      throw error;
    }

    if (this.#isStartActive(token, kernel)) return;
    setInstalled(false);
    throw this.#removeLateListener(
      new Error("ThreeStageRenderer start was cancelled"),
      uninstall,
    );
  }

  #removeLateListener(primary: unknown, uninstall: () => void): unknown {
    try {
      uninstall();
      return primary;
    } catch (cleanupError) {
      return withCleanupError(
        primary,
        cleanupError,
        "ThreeStageRenderer start was cancelled and late cleanup failed",
      );
    }
  }

  #resizeStarting(
    token: StartToken,
    kernel: ThreeStageRendererKernel,
  ): void {
    const width = this.#dom.canvas.clientWidth;
    this.#assertStartActive(token, kernel);
    const height = this.#dom.canvas.clientHeight;
    this.#assertStartActive(token, kernel);
    if (width <= 0 || height <= 0) return;

    const pixelRatio = this.#readPixelRatio();
    this.#assertStartActive(token, kernel);
    if (pixelRatio !== this.#appliedPixelRatio) {
      kernel.renderer.setPixelRatio(pixelRatio);
      this.#assertStartActive(token, kernel);
      this.#appliedPixelRatio = pixelRatio;
    }
    kernel.renderer.setSize(width, height, false);
    this.#assertStartActive(token, kernel);
    kernel.camera.aspect = width / height;
    this.#assertStartActive(token, kernel);
    kernel.camera.updateProjectionMatrix();
    this.#assertStartActive(token, kernel);
  }

  #resizeRunning(kernel: ThreeStageRendererKernel): void {
    const width = this.#dom.canvas.clientWidth;
    if (!this.#isRunningKernel(kernel)) return;
    const height = this.#dom.canvas.clientHeight;
    if (!this.#isRunningKernel(kernel) || width <= 0 || height <= 0) return;

    const pixelRatio = this.#readPixelRatio();
    if (!this.#isRunningKernel(kernel)) return;
    if (pixelRatio !== this.#appliedPixelRatio) {
      kernel.renderer.setPixelRatio(pixelRatio);
      if (!this.#isRunningKernel(kernel)) return;
      this.#appliedPixelRatio = pixelRatio;
    }
    kernel.renderer.setSize(width, height, false);
    if (!this.#isRunningKernel(kernel)) return;
    kernel.camera.aspect = width / height;
    if (!this.#isRunningKernel(kernel)) return;
    kernel.camera.updateProjectionMatrix();
  }

  #readPixelRatio(): number {
    const reportedRatio = this.#browser.devicePixelRatio();
    return Number.isFinite(reportedRatio) && reportedRatio > 0
      ? Math.min(reportedRatio, 2)
      : 1;
  }

  #renderFrame(generation: number, nowMilliseconds: number): void {
    if (
      this.#state !== "running" ||
      generation !== this.#animationGeneration
    ) {
      return;
    }

    this.#animationFrame = undefined;
    this.#runRuntimeCallback((kernel) => {
      const deltaSeconds =
        this.#lastFrameTime === undefined
          ? 0
          : Math.max(0, nowMilliseconds - this.#lastFrameTime) / 1_000;
      this.#lastFrameTime = nowMilliseconds;

      kernel.updateFrame(deltaSeconds, nowMilliseconds);
      if (!this.#isRunningKernel(kernel)) return;
      kernel.controls.update();
      if (!this.#isRunningKernel(kernel)) return;
      kernel.renderer.render(kernel.scene, kernel.camera);
      if (!this.#isRunningKernel(kernel)) return;
      this.#scheduleRunningFrame(kernel);
    });
  }

  #scheduleRunningFrame(kernel: ThreeStageRendererKernel): void {
    if (this.#animationFrame !== undefined) {
      throw new Error("ThreeStageRenderer already owns an animation frame");
    }
    const generation = ++this.#animationGeneration;
    const handle = this.#browser.requestAnimationFrame((now) =>
      this.#renderFrame(generation, now),
    );
    this.#animationFrame = handle;

    if (this.#isRunningKernel(kernel)) return;
    // A dispose inside requestAnimationFrame could not see the not-yet-returned
    // handle. Take the late handle now and cancel it before returning.
    this.#releaseOwnedResources();
  }

  #runRuntimeCallback(
    callback: (kernel: ThreeStageRendererKernel) => void,
  ): void {
    const kernel = this.#kernel;
    if (this.#state !== "running" || !kernel) return;
    try {
      callback(kernel);
    } catch (error) {
      this.#handleRuntimeFailure(error);
    }
  }

  #handleRuntimeFailure(error: unknown): void {
    if (this.#runtimeErrorReported) return;
    this.#runtimeErrorReported = true;
    if (this.#state !== "disposed") this.#state = "failed";
    this.#startToken = null;

    let reportable = error;
    try {
      this.#releaseOwnedResources();
    } catch (cleanupError) {
      reportable = withCleanupError(
        error,
        cleanupError,
        "ThreeStageRenderer runtime failed and cleanup was incomplete",
      );
    }

    try {
      this.#browser.reportError(reportable);
    } catch {
      // A faulty reporter must not restart callbacks or replace the renderer's
      // terminal failure with a second uncaught exception.
    }
  }

  #isStartActive(
    token: StartToken,
    kernel: ThreeStageRendererKernel,
  ): boolean {
    return (
      this.#state === "starting" &&
      this.#startToken === token &&
      this.#kernel === kernel
    );
  }

  #assertStartActive(
    token: StartToken,
    kernel: ThreeStageRendererKernel,
  ): void {
    if (!this.#isStartActive(token, kernel)) {
      throw new Error("ThreeStageRenderer start was cancelled");
    }
  }

  #isRunningKernel(kernel: ThreeStageRendererKernel): boolean {
    return this.#state === "running" && this.#kernel === kernel;
  }

  #isDisposed(): boolean {
    return this.#state === "disposed";
  }

  #releaseOwnedResources(): void {
    // Atomically relinquish every reference before invoking foreign cleanup.
    // Re-entrant dispose calls therefore observe an empty ownership set and
    // cannot release the same Three.js object twice.
    const animationFrame = this.#animationFrame;
    this.#animationFrame = undefined;
    const observer = this.#resizeObserver;
    this.#resizeObserver = null;
    const removeWindowResize = this.#windowResizeRegistered;
    this.#windowResizeRegistered = false;
    const removeCanvasWheel = this.#canvasWheelRegistered;
    this.#canvasWheelRegistered = false;
    const removeControlsStart = this.#controlsStartRegistered;
    this.#controlsStartRegistered = false;
    const removeControlsEnd = this.#controlsEndRegistered;
    this.#controlsEndRegistered = false;
    const kernel = this.#kernel;
    this.#kernel = null;
    this.#startToken = null;
    this.#lastFrameTime = undefined;
    this.#appliedPixelRatio = undefined;
    this.#animationGeneration += 1;

    const errors: unknown[] = [];
    const capture = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        appendCleanupError(errors, error);
      }
    };

    if (animationFrame !== undefined) {
      capture(() => this.#browser.cancelAnimationFrame(animationFrame));
    }
    if (observer) capture(() => observer.disconnect());
    if (removeWindowResize) {
      capture(() =>
        this.#browser.windowTarget.removeEventListener(
          "resize",
          this.#onWindowResize,
        ),
      );
    }
    if (removeCanvasWheel) {
      capture(() =>
        this.#dom.canvas.removeEventListener("wheel", this.#onCanvasWheel),
      );
    }
    if (kernel && removeControlsStart) {
      capture(() =>
        kernel.controls.removeEventListener("start", this.#onControlsStart),
      );
    }
    if (kernel && removeControlsEnd) {
      capture(() =>
        kernel.controls.removeEventListener("end", this.#onControlsEnd),
      );
    }

    if (kernel) {
      // This inventory is deliberately independent from shutdown(): a failure
      // while cancelling secondary work must not hide detached GPU resources.
      const extras = snapshotDisposalResources(kernel.disposalResources);
      capture(() => kernel.shutdown());
      capture(() => kernel.controls.dispose());
      capture(() =>
        this.#resourceDisposer.disposeObject3DResources(
          kernel.scene,
          extras,
        ),
      );

      // Scene.clear() releases graph references, not GPU resources; it must
      // therefore follow ThreeResourceDisposer. Null the Scene-owned aliases
      // before dropping the renderer's final reference.
      capture(() => kernel.scene.clear());
      capture(() => {
        kernel.scene.background = null;
        kernel.scene.environment = null;
        kernel.scene.overrideMaterial = null;
      });

      // WebGLRenderer is the outermost owner and is deliberately last: all
      // subordinate resources have received their cleanup opportunity first.
      capture(() => kernel.renderer.dispose());
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Failed to release every ThreeStageRenderer resource",
      );
    }
  }
}
