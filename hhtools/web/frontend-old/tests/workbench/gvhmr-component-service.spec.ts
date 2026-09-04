import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserGvhmrComponentService } from "../../src/workbench/services/gvhmr/browser/browser-gvhmr-component-service";
import type {
  GvhmrOptionalComponentState,
  GvhmrSetupResult,
} from "../../src/workbench/services/gvhmr/common/gvhmr-component-service";

const componentState: GvhmrOptionalComponentState = {
  requested: true,
  configured: true,
  root: "/opt/gvhmr",
  guideUrl: "https://example.test/gvhmr",
  estimatedAdditionalBytes: 4_096,
};

const setupResult: GvhmrSetupResult = {
  action: "configured",
  state: componentState,
};

function createDesktopApi() {
  return {
    getRuntimeState: vi.fn(async () => ({})),
    getOptionalComponents: vi.fn(async () => ({ gvhmr: componentState })),
    restartBackend: vi.fn(async () => ({})),
    setupGvhmr: vi.fn(async () => setupResult),
    selectDirectory: vi.fn(async () => null),
    openExternal: vi.fn(async () => undefined),
    onRuntimeStateChanged: vi.fn(() => () => undefined),
  } satisfies NonNullable<Window["hhtoolsDesktop"]>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BrowserGvhmrComponentService", () => {
  it("returns null when the renderer has no desktop preload", async () => {
    delete window.hhtoolsDesktop;
    const service = new BrowserGvhmrComponentService();

    await expect(service.getState()).resolves.toBeNull();
    await expect(service.setup()).resolves.toBeNull();
  });

  it("reads and unwraps component state from the desktop preload", async () => {
    const desktop = createDesktopApi();
    vi.stubGlobal("hhtoolsDesktop", desktop);
    const service = new BrowserGvhmrComponentService();

    await expect(service.getState()).resolves.toBe(componentState);
    expect(desktop.getOptionalComponents).toHaveBeenCalledOnce();
  });

  it("forwards setup to the desktop preload and preserves its result", async () => {
    const desktop = createDesktopApi();
    vi.stubGlobal("hhtoolsDesktop", desktop);
    const service = new BrowserGvhmrComponentService();

    await expect(service.setup()).resolves.toBe(setupResult);
    expect(desktop.setupGvhmr).toHaveBeenCalledOnce();
  });

  it("does not hide errors raised by the desktop setup flow", async () => {
    const desktop = createDesktopApi();
    desktop.setupGvhmr.mockRejectedValueOnce(new Error("setup failed"));
    vi.stubGlobal("hhtoolsDesktop", desktop);
    const service = new BrowserGvhmrComponentService();

    await expect(service.setup()).rejects.toThrow("setup failed");
  });
});
