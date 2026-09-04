import { describe, expect, it, vi } from "vitest";
import {
  BoxGeometry,
  type Camera,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Texture,
  type WebGLRenderer,
} from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  ThreeResourceDisposer,
  type ThreeResourceExtras,
} from "../../src/platform/graphics/common/three-resource-disposer";
import {
  ThreeStageRenderer,
  type ThreeStageBrowserEnvironment,
  type ThreeStageControls,
  type ThreeStagePerspectiveCamera,
  type ThreeStageRendererBackend,
  type ThreeStageRendererKernel,
} from "../../src/workbench/browser/stage/three-stage-renderer";

type AssertAssignable<Expected, Actual extends Expected> = true;
type WebGlRendererMatchesBackend = AssertAssignable<
  ThreeStageRendererBackend,
  WebGLRenderer
>;
type PerspectiveCameraMatchesKernel = AssertAssignable<
  ThreeStagePerspectiveCamera,
  PerspectiveCamera
>;
type OrbitControlsMatchKernel = AssertAssignable<
  ThreeStageControls,
  OrbitControls<PerspectiveCamera>
>;

// Keep these compile-time checks live without adding a runtime dependency.
type ThreeStageRealTypeCompatibility = [
  WebGlRendererMatchesBackend,
  PerspectiveCameraMatchesKernel,
  OrbitControlsMatchKernel,
];
const realTypeCompatibility: ThreeStageRealTypeCompatibility = [
  true,
  true,
  true,
];
void realTypeCompatibility;

class RecordingEventTarget implements EventTarget {
  readonly #target = new EventTarget();
  readonly order: string[];

  constructor(order: string[]) {
    this.order = order;
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.#target.addEventListener(type, callback, options);
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.order.push(`window:remove:${type}`);
    this.#target.removeEventListener(type, callback, options);
  }

  dispatchEvent(event: Event): boolean {
    return this.#target.dispatchEvent(event);
  }
}

class TestControls implements ThreeStageControls {
  readonly #listeners = {
    start: new Set<() => void>(),
    end: new Set<() => void>(),
  };
  readonly order: string[];
  domElement: HTMLElement | SVGElement | null;
  object: Camera;
  readonly update = vi.fn(() => this.order.push("controls:update"));
  readonly dispose = vi.fn(() => this.order.push("controls:dispose"));
  failOnAdd: "start" | "end" | undefined;

  constructor(
    order: string[],
    domElement: HTMLElement | SVGElement,
    object: Camera,
  ) {
    this.order = order;
    this.domElement = domElement;
    this.object = object;
  }

  addEventListener(type: "start" | "end", listener: () => void): void {
    this.#listeners[type].add(listener);
    if (this.failOnAdd === type) throw new Error(`${type} listener failed`);
  }

  removeEventListener(type: "start" | "end", listener: () => void): void {
    this.order.push(`controls:remove:${type}`);
    this.#listeners[type].delete(listener);
  }

  emit(type: "start" | "end"): void {
    for (const listener of this.#listeners[type]) listener();
  }
}

function createHarness() {
  const order: string[] = [];
  const stage = document.createElement("main");
  const canvas = document.createElement("canvas");
  stage.append(canvas);
  const canvasAddEventListener = vi.spyOn(canvas, "addEventListener");

  let width = 320;
  let height = 180;
  Object.defineProperties(canvas, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
  });

  const windowTarget = new RecordingEventTarget(order);
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrame = 1;
  let resizeCallback: (() => void) | undefined;
  let pixelRatio = 3;
  let now = 40;

  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const handle = nextAnimationFrame++;
    animationFrames.set(handle, callback);
    return handle;
  });
  const cancelAnimationFrame = vi.fn((handle: number) => {
    order.push("raf:cancel");
    animationFrames.delete(handle);
  });
  const resizeObserver = {
    observe: vi.fn<(target: Element) => void>(),
    disconnect: vi.fn(() => order.push("observer:disconnect")),
  };
  const reportError = vi.fn<(error: unknown) => void>();
  const browser: ThreeStageBrowserEnvironment = {
    windowTarget,
    requestAnimationFrame,
    cancelAnimationFrame,
    createResizeObserver: vi.fn((callback: () => void) => {
      resizeCallback = callback;
      return resizeObserver;
    }),
    devicePixelRatio: vi.fn(() => pixelRatio),
    now: vi.fn(() => now),
    reportError,
  };

  const camera = new PerspectiveCamera();
  const updateProjectionMatrix = vi.spyOn(camera, "updateProjectionMatrix");
  const scene = new Scene();
  const controls = new TestControls(order, canvas, camera);
  const renderer = {
    domElement: canvas,
    setPixelRatio: vi.fn((value: number) =>
      order.push(`renderer:pixel-ratio:${value}`),
    ),
    setSize: vi.fn((nextWidth: number, nextHeight: number) =>
      order.push(`renderer:size:${nextWidth}x${nextHeight}`),
    ),
    render: vi.fn(() => order.push("renderer:render")),
    dispose: vi.fn(() => order.push("renderer:dispose")),
  };
  const updateFrame = vi.fn((deltaSeconds: number, frameNow: number) => {
    order.push(`kernel:update:${deltaSeconds}:${frameNow}`);
  });
  const resetView = vi.fn();
  const onCanvasWheel = vi.fn();
  const onControlsStart = vi.fn();
  const onControlsEnd = vi.fn();
  const disposalResources: {
    geometries?: ThreeResourceExtras["geometries"];
    materials?: ThreeResourceExtras["materials"];
    textures?: ThreeResourceExtras["textures"];
  } = {};
  const shutdown = vi.fn<ThreeStageRendererKernel["shutdown"]>(() => {
    order.push("kernel:shutdown");
  });
  const kernel: ThreeStageRendererKernel = {
    scene,
    camera,
    renderer,
    controls,
    disposalResources,
    updateFrame,
    resetView,
    onCanvasWheel,
    onControlsStart,
    onControlsEnd,
    shutdown,
  };
  const createKernel = vi.fn(() => kernel);
  const concreteResourceDisposer = new ThreeResourceDisposer();
  const resourceDisposer = {
    disposeObject3DResources: vi.fn(
      (root: Scene, extras?: ThreeResourceExtras) => {
        order.push("scene:resources");
        concreteResourceDisposer.disposeObject3DResources(root, extras);
      },
    ),
  };

  const createRenderer = () =>
    new ThreeStageRenderer({
      dom: { stage, canvas },
      browser,
      createKernel,
      resourceDisposer,
    });
  const fireAnimationFrame = (handle: number, frameNow: number) => {
    const callback = animationFrames.get(handle);
    if (!callback) throw new Error(`Missing animation frame ${handle}`);
    animationFrames.delete(handle);
    callback(frameNow);
  };

  return {
    animationFrames,
    browser,
    camera,
    cancelAnimationFrame,
    canvas,
    canvasAddEventListener,
    controls,
    createKernel,
    createRenderer,
    disposalResources,
    fireAnimationFrame,
    kernel,
    onCanvasWheel,
    onControlsEnd,
    onControlsStart,
    order,
    renderer,
    reportError,
    requestAnimationFrame,
    resetView,
    resizeObserver,
    resourceDisposer,
    scene,
    shutdown,
    setDimensions: (nextWidth: number, nextHeight: number) => {
      width = nextWidth;
      height = nextHeight;
    },
    setNow: (nextNow: number) => {
      now = nextNow;
    },
    setPixelRatio: (nextRatio: number) => {
      pixelRatio = nextRatio;
    },
    triggerResize: () => resizeCallback?.(),
    updateFrame,
    updateProjectionMatrix,
    windowTarget,
  };
}

describe("ThreeStageRenderer", () => {
  it("keeps construction inert and fails closed outside a live start", () => {
    const harness = createHarness();
    const stageRenderer = harness.createRenderer();

    expect(harness.createKernel).not.toHaveBeenCalled();
    expect(harness.requestAnimationFrame).not.toHaveBeenCalled();
    expect(harness.browser.createResizeObserver).not.toHaveBeenCalled();
    expect(() => stageRenderer.resetView()).not.toThrow();
    expect(harness.resetView).not.toHaveBeenCalled();

    stageRenderer.dispose();
    stageRenderer.dispose();

    expect(harness.createKernel).not.toHaveBeenCalled();
    expect(() => stageRenderer.start()).toThrow(
      "Cannot start a disposed ThreeStageRenderer",
    );
  });

  it("starts once with explicit DOM refs and routes owned input listeners", () => {
    const harness = createHarness();
    const stageRenderer = harness.createRenderer();

    stageRenderer.start();

    expect(harness.createKernel).toHaveBeenCalledWith({
      stage: harness.canvas.parentElement,
      canvas: harness.canvas,
    });
    expect(harness.resizeObserver.observe).toHaveBeenCalledWith(
      harness.canvas.parentElement,
    );
    expect(harness.renderer.setPixelRatio).toHaveBeenCalledWith(2);
    expect(harness.renderer.setSize).toHaveBeenCalledWith(320, 180, false);
    expect(harness.camera.aspect).toBeCloseTo(320 / 180);
    expect(harness.updateProjectionMatrix).toHaveBeenCalledOnce();
    expect(harness.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(harness.canvasAddEventListener).toHaveBeenCalledWith(
      "wheel",
      expect.any(Function),
      { passive: false },
    );

    const wheel = new WheelEvent("wheel", { deltaY: 12 });
    harness.canvas.dispatchEvent(wheel);
    harness.controls.emit("start");
    harness.setNow(55);
    harness.controls.emit("end");
    stageRenderer.resetView();

    expect(harness.onCanvasWheel).toHaveBeenCalledWith(wheel);
    expect(harness.onControlsStart).toHaveBeenCalledWith(40);
    expect(harness.onControlsEnd).toHaveBeenCalledWith(55);
    expect(harness.resetView).toHaveBeenCalledOnce();
    expect(() => stageRenderer.start()).toThrow(
      "ThreeStageRenderer start has already been attempted",
    );

    stageRenderer.dispose();
  });

  it("rejects a kernel bound to another canvas and disposes it transactionally", () => {
    const harness = createHarness();
    harness.renderer.domElement = document.createElement("canvas");
    const stageRenderer = harness.createRenderer();

    expect(() => stageRenderer.start()).toThrow(
      "ThreeStageRenderer kernel must own the supplied canvas",
    );

    expect(harness.browser.createResizeObserver).not.toHaveBeenCalled();
    expect(harness.requestAnimationFrame).not.toHaveBeenCalled();
    expect(harness.controls.dispose).toHaveBeenCalledOnce();
    expect(harness.resourceDisposer.disposeObject3DResources).toHaveBeenCalledWith(
      harness.scene,
      { geometries: undefined, materials: undefined, textures: undefined },
    );
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(() => stageRenderer.resetView()).not.toThrow();
  });

  it("rejects controls bound to another canvas or camera", () => {
    const cases = [
      {
        message: "ThreeStageRenderer controls must own the supplied canvas",
        mutate: (harness: ReturnType<typeof createHarness>) => {
          harness.controls.domElement = document.createElement("canvas");
        },
      },
      {
        message: "ThreeStageRenderer controls must own the kernel camera",
        mutate: (harness: ReturnType<typeof createHarness>) => {
          harness.controls.object = new PerspectiveCamera();
        },
      },
    ];

    for (const { message, mutate } of cases) {
      const harness = createHarness();
      mutate(harness);
      const stageRenderer = harness.createRenderer();

      expect(() => stageRenderer.start()).toThrow(message);
      expect(harness.shutdown).toHaveBeenCalledOnce();
      expect(harness.controls.dispose).toHaveBeenCalledOnce();
      expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    }
  });

  it("keeps a kernel-construction failure terminal without phantom cleanup", () => {
    const harness = createHarness();
    const failure = new Error("kernel failed");
    harness.createKernel.mockImplementation((): ThreeStageRendererKernel => {
      throw failure;
    });
    const stageRenderer = harness.createRenderer();

    expect(() => stageRenderer.start()).toThrow(failure);

    expect(harness.browser.createResizeObserver).not.toHaveBeenCalled();
    expect(harness.resourceDisposer.disposeObject3DResources).not.toHaveBeenCalled();
    expect(harness.renderer.dispose).not.toHaveBeenCalled();
    expect(() => stageRenderer.start()).toThrow(
      "ThreeStageRenderer start has already been attempted",
    );
    expect(() => stageRenderer.dispose()).not.toThrow();
  });

  it("removes a listener whose registration produced a side effect then failed", () => {
    const harness = createHarness();
    harness.controls.failOnAdd = "end";
    const stageRenderer = harness.createRenderer();

    expect(() => stageRenderer.start()).toThrow("end listener failed");

    expect(harness.order).toContain("controls:remove:start");
    expect(harness.order).toContain("controls:remove:end");
    expect(harness.controls.dispose).toHaveBeenCalledOnce();
    expect(harness.browser.createResizeObserver).not.toHaveBeenCalled();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    harness.controls.emit("end");
    expect(harness.onControlsEnd).not.toHaveBeenCalled();
  });

  it("disconnects an observer whose observe side effect then throws", () => {
    const harness = createHarness();
    const failure = new Error("observe failed");
    let observeSideEffect = false;
    harness.resizeObserver.observe.mockImplementation(() => {
      observeSideEffect = true;
      throw failure;
    });
    const stageRenderer = harness.createRenderer();

    expect(() => stageRenderer.start()).toThrow(failure);

    expect(observeSideEffect).toBe(true);
    expect(harness.resizeObserver.disconnect).toHaveBeenCalledOnce();
    expect(harness.shutdown).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("does not schedule a frame when dispose wins during initial resize", () => {
    const harness = createHarness();
    let stageRenderer: ThreeStageRenderer;
    harness.renderer.setSize.mockImplementation((width, height) => {
      harness.order.push(`renderer:size:${width}x${height}`);
      stageRenderer.dispose();
      return harness.order.length;
    });
    stageRenderer = harness.createRenderer();

    expect(() => stageRenderer.start()).toThrow(
      "ThreeStageRenderer start was cancelled",
    );

    expect(harness.requestAnimationFrame).not.toHaveBeenCalled();
    expect(harness.resizeObserver.disconnect).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(() => stageRenderer.resetView()).not.toThrow();
  });

  it("cancels a RAF handle returned after re-entrant startup disposal", () => {
    const harness = createHarness();
    let stageRenderer: ThreeStageRenderer;
    harness.requestAnimationFrame.mockImplementation((callback) => {
      stageRenderer.dispose();
      const handle = 77;
      harness.animationFrames.set(handle, callback);
      return handle;
    });
    stageRenderer = harness.createRenderer();

    expect(() => stageRenderer.start()).toThrow(
      "ThreeStageRenderer start was cancelled",
    );

    expect(harness.cancelAnimationFrame).toHaveBeenCalledWith(77);
    expect(harness.animationFrames.size).toBe(0);
    expect(harness.shutdown).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
  });

  it("skips zero-sized surfaces and applies later resize and DPR changes", () => {
    const harness = createHarness();
    const stageRenderer = harness.createRenderer();
    harness.setDimensions(0, 180);

    stageRenderer.start();

    expect(harness.renderer.setSize).not.toHaveBeenCalled();
    expect(harness.updateProjectionMatrix).not.toHaveBeenCalled();

    harness.setDimensions(640, 0);
    harness.triggerResize();
    expect(harness.renderer.setSize).not.toHaveBeenCalled();

    harness.setPixelRatio(1.25);
    harness.setDimensions(640, 360);
    harness.windowTarget.dispatchEvent(new Event("resize"));

    expect(harness.renderer.setPixelRatio).toHaveBeenCalledWith(1.25);
    expect(harness.renderer.setSize).toHaveBeenCalledWith(640, 360, false);
    expect(harness.camera.aspect).toBeCloseTo(640 / 360);
    expect(harness.updateProjectionMatrix).toHaveBeenCalledOnce();

    harness.triggerResize();
    expect(harness.renderer.setPixelRatio).toHaveBeenCalledTimes(1);
    expect(harness.renderer.setSize).toHaveBeenCalledTimes(2);

    stageRenderer.dispose();
  });

  it("runs one RAF chain in update, controls, render order", () => {
    const harness = createHarness();
    const stageRenderer = harness.createRenderer();
    stageRenderer.start();
    harness.order.length = 0;

    harness.fireAnimationFrame(1, 100);

    expect(harness.order).toEqual([
      "kernel:update:0:100",
      "controls:update",
      "renderer:render",
    ]);
    expect(harness.animationFrames.size).toBe(1);
    expect(harness.requestAnimationFrame).toHaveBeenCalledTimes(2);

    harness.order.length = 0;
    harness.fireAnimationFrame(2, 116);
    expect(harness.order).toEqual([
      "kernel:update:0.016:116",
      "controls:update",
      "renderer:render",
    ]);
    expect(harness.animationFrames.size).toBe(1);

    stageRenderer.dispose();
  });

  it("reports the first frame failure once and permanently stops the chain", () => {
    const harness = createHarness();
    const failure = new Error("frame failed");
    harness.updateFrame.mockImplementation(() => {
      throw failure;
    });
    harness.reportError.mockImplementation(() => {
      throw new Error("reporter failed");
    });
    const stageRenderer = harness.createRenderer();
    stageRenderer.start();
    const staleCallback = harness.animationFrames.get(1);

    expect(() => harness.fireAnimationFrame(1, 100)).not.toThrow();
    staleCallback?.(101);

    expect(harness.reportError).toHaveBeenCalledOnce();
    expect(harness.reportError).toHaveBeenCalledWith(failure);
    expect(harness.controls.update).not.toHaveBeenCalled();
    expect(harness.renderer.render).not.toHaveBeenCalled();
    expect(harness.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(harness.animationFrames.size).toBe(0);
    expect(harness.shutdown).toHaveBeenCalledOnce();
    expect(harness.controls.dispose).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(() => stageRenderer.resetView()).not.toThrow();
    expect(harness.resetView).not.toHaveBeenCalled();

    stageRenderer.dispose();
  });

  it("reports a frame failure with flattened eager-cleanup errors", () => {
    const harness = createHarness();
    const frameFailure = new Error("frame failed");
    const controlsFailure = new Error("controls cleanup failed");
    const firstResourceFailure = new Error("geometry cleanup failed");
    const secondResourceFailure = new Error("texture cleanup failed");
    harness.updateFrame.mockImplementation(() => {
      throw frameFailure;
    });
    harness.controls.dispose.mockImplementation(() => {
      harness.order.push("controls:dispose");
      throw controlsFailure;
    });
    harness.resourceDisposer.disposeObject3DResources.mockImplementation(() => {
      harness.order.push("scene:resources");
      throw new AggregateError([
        firstResourceFailure,
        secondResourceFailure,
      ]);
    });
    const stageRenderer = harness.createRenderer();
    stageRenderer.start();
    const staleCallback = harness.animationFrames.get(1);

    expect(() => harness.fireAnimationFrame(1, 100)).not.toThrow();
    staleCallback?.(101);

    expect(harness.reportError).toHaveBeenCalledOnce();
    const reportable = harness.reportError.mock.calls[0]?.[0];
    expect(reportable).toBeInstanceOf(AggregateError);
    expect((reportable as AggregateError).errors).toEqual([
      frameFailure,
      controlsFailure,
      firstResourceFailure,
      secondResourceFailure,
    ]);
    expect(harness.shutdown).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.animationFrames.size).toBe(0);
    expect(() => stageRenderer.dispose()).not.toThrow();
  });

  it("treats an input-listener exception as a terminal runtime failure", () => {
    const harness = createHarness();
    const failure = new Error("wheel failed");
    harness.onCanvasWheel.mockImplementation(() => {
      throw failure;
    });
    const stageRenderer = harness.createRenderer();
    stageRenderer.start();

    harness.canvas.dispatchEvent(new WheelEvent("wheel"));
    harness.triggerResize();
    harness.controls.emit("start");

    expect(harness.reportError).toHaveBeenCalledOnce();
    expect(harness.reportError).toHaveBeenCalledWith(failure);
    expect(harness.shutdown).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.animationFrames.size).toBe(0);
    expect(harness.onControlsStart).not.toHaveBeenCalled();
    expect(() => stageRenderer.resetView()).not.toThrow();
  });

  it("disposes in ownership order and makes an escaped RAF callback stale", () => {
    const harness = createHarness();
    const geometry = new BoxGeometry();
    const texture = new Texture();
    const material = new MeshBasicMaterial({ map: texture });
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeTexture = vi.spyOn(texture, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    const detachedGeometry = new BoxGeometry();
    const detachedTexture = new Texture();
    const detachedMaterial = new MeshBasicMaterial({ map: detachedTexture });
    const disposeDetachedGeometry = vi.spyOn(detachedGeometry, "dispose");
    const disposeDetachedTexture = vi.spyOn(detachedTexture, "dispose");
    const disposeDetachedMaterial = vi.spyOn(detachedMaterial, "dispose");
    let kernelAlive = true;
    let lateMutationCount = 0;
    const lateKernelCallback = () => {
      if (kernelAlive) lateMutationCount += 1;
    };
    harness.disposalResources.geometries = [detachedGeometry];
    harness.disposalResources.materials = [detachedMaterial];
    harness.shutdown.mockImplementation(() => {
      harness.order.push("kernel:shutdown");
      kernelAlive = false;
    });
    harness.scene.add(new Mesh(geometry, material));
    harness.scene.background = texture;
    const originalCanvasRemove = harness.canvas.removeEventListener.bind(
      harness.canvas,
    );
    vi.spyOn(harness.canvas, "removeEventListener").mockImplementation(
      (type, listener, options) => {
        harness.order.push(`canvas:remove:${type}`);
        originalCanvasRemove(type, listener, options);
      },
    );
    const originalSceneClear = harness.scene.clear.bind(harness.scene);
    vi.spyOn(harness.scene, "clear").mockImplementation(() => {
      harness.order.push("scene:clear");
      return originalSceneClear();
    });
    const stageRenderer = harness.createRenderer();
    stageRenderer.start();
    const staleCallback = harness.animationFrames.get(1);
    harness.order.length = 0;

    stageRenderer.dispose();
    stageRenderer.dispose();
    staleCallback?.(100);
    harness.triggerResize();
    harness.controls.emit("start");
    harness.windowTarget.dispatchEvent(new Event("resize"));
    harness.canvas.dispatchEvent(new WheelEvent("wheel"));
    lateKernelCallback();

    expect(harness.order).toEqual([
      "raf:cancel",
      "observer:disconnect",
      "window:remove:resize",
      "canvas:remove:wheel",
      "controls:remove:start",
      "controls:remove:end",
      "kernel:shutdown",
      "controls:dispose",
      "scene:resources",
      "scene:clear",
      "renderer:dispose",
    ]);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(disposeDetachedGeometry).toHaveBeenCalledOnce();
    expect(disposeDetachedTexture).toHaveBeenCalledOnce();
    expect(disposeDetachedMaterial).toHaveBeenCalledOnce();
    expect(harness.resourceDisposer.disposeObject3DResources).toHaveBeenCalledWith(
      harness.scene,
      expect.objectContaining({
        geometries: [detachedGeometry],
        materials: [detachedMaterial],
      }),
    );
    expect(harness.scene.children).toHaveLength(0);
    expect(harness.scene.background).toBeNull();
    expect(harness.updateFrame).not.toHaveBeenCalled();
    expect(harness.renderer.render).not.toHaveBeenCalled();
    expect(harness.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(harness.onCanvasWheel).not.toHaveBeenCalled();
    expect(harness.onControlsStart).not.toHaveBeenCalled();
    expect(lateMutationCount).toBe(0);
  });

  it("rolls back a fully acquired kernel when the initial RAF fails", () => {
    const harness = createHarness();
    const failure = new Error("RAF unavailable");
    harness.requestAnimationFrame.mockImplementation((): number => {
      throw failure;
    });
    const stageRenderer = harness.createRenderer();

    expect(() => stageRenderer.start()).toThrow(failure);

    expect(harness.resizeObserver.disconnect).toHaveBeenCalledOnce();
    expect(harness.controls.dispose).toHaveBeenCalledOnce();
    expect(harness.resourceDisposer.disposeObject3DResources).toHaveBeenCalledWith(
      harness.scene,
      { geometries: undefined, materials: undefined, textures: undefined },
    );
    expect(harness.scene.children).toHaveLength(0);
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(() => stageRenderer.start()).toThrow(
      "ThreeStageRenderer start has already been attempted",
    );

    stageRenderer.dispose();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
  });

  it("snapshots detached resources before kernel shutdown mutates and fails", () => {
    const harness = createHarness();
    const shutdownFailure = new Error("kernel shutdown failed");
    const detachedGeometry = new BoxGeometry();
    const detachedTexture = new Texture();
    const detachedMaterial = new MeshBasicMaterial({ map: detachedTexture });
    const disposeGeometry = vi.spyOn(detachedGeometry, "dispose");
    const disposeTexture = vi.spyOn(detachedTexture, "dispose");
    const disposeMaterial = vi.spyOn(detachedMaterial, "dispose");
    harness.disposalResources.geometries = [detachedGeometry];
    harness.disposalResources.materials = [detachedMaterial];
    harness.shutdown.mockImplementation(() => {
      harness.order.push("kernel:shutdown");
      harness.disposalResources.geometries = [];
      harness.disposalResources.materials = [];
      throw shutdownFailure;
    });
    const stageRenderer = harness.createRenderer();
    stageRenderer.start();

    let thrown: unknown;
    try {
      stageRenderer.dispose();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([shutdownFailure]);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.order.at(-1)).toBe("renderer:dispose");
  });

  it("aggregates cleanup failures while still reaching renderer disposal", () => {
    const harness = createHarness();
    const cancelFailure = new Error("cancel failed");
    const controlsFailure = new Error("controls failed");
    const firstResourceFailure = new Error("geometry failed");
    const secondResourceFailure = new Error("material failed");
    const sceneFailure = new Error("scene clear failed");
    const rendererFailure = new Error("renderer failed");
    harness.cancelAnimationFrame.mockImplementation(() => {
      harness.order.push("raf:cancel");
      throw cancelFailure;
    });
    harness.controls.dispose.mockImplementation(() => {
      harness.order.push("controls:dispose");
      throw controlsFailure;
    });
    harness.resourceDisposer.disposeObject3DResources.mockImplementation(() => {
      harness.order.push("scene:resources");
      throw new AggregateError([
        firstResourceFailure,
        secondResourceFailure,
      ]);
    });
    vi.spyOn(harness.scene, "clear").mockImplementation(() => {
      harness.order.push("scene:clear");
      throw sceneFailure;
    });
    harness.renderer.dispose.mockImplementation(() => {
      harness.order.push("renderer:dispose");
      throw rendererFailure;
    });
    harness.scene.background = new Texture();
    const stageRenderer = harness.createRenderer();
    stageRenderer.start();
    harness.order.length = 0;

    let thrown: unknown;
    try {
      stageRenderer.dispose();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      cancelFailure,
      controlsFailure,
      firstResourceFailure,
      secondResourceFailure,
      sceneFailure,
      rendererFailure,
    ]);
    expect(harness.order.at(-1)).toBe("renderer:dispose");
    expect(harness.scene.background).toBeNull();
    expect(() => stageRenderer.dispose()).not.toThrow();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
  });

  it("reports re-entrant disposal failure once without reviving ownership", () => {
    const harness = createHarness();
    const cleanupFailure = new Error("controls cleanup failed");
    const stageRenderer = harness.createRenderer();
    harness.controls.dispose.mockImplementation(() => {
      harness.order.push("controls:dispose");
      throw cleanupFailure;
    });
    harness.updateFrame.mockImplementation(() => stageRenderer.dispose());
    stageRenderer.start();
    const staleCallback = harness.animationFrames.get(1);

    expect(() => harness.fireAnimationFrame(1, 100)).not.toThrow();
    staleCallback?.(101);

    expect(harness.controls.update).not.toHaveBeenCalled();
    expect(harness.renderer.render).not.toHaveBeenCalled();
    expect(harness.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(harness.renderer.dispose).toHaveBeenCalledOnce();
    expect(harness.reportError).toHaveBeenCalledOnce();
    const reportable = harness.reportError.mock.calls[0]?.[0];
    expect(reportable).toBeInstanceOf(AggregateError);
    expect((reportable as AggregateError).errors).toEqual([cleanupFailure]);
    expect(() => stageRenderer.resetView()).not.toThrow();
    expect(() => stageRenderer.dispose()).not.toThrow();
    expect(harness.controls.dispose).toHaveBeenCalledOnce();
  });
});
