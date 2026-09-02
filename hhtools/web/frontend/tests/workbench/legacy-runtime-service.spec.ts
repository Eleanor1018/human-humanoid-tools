import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/runtime/webui-runtime", () => ({}));
vi.mock("../../src/runtime/dataset-viz", () => ({}));

import { BrowserLegacyRuntimeService } from "../../src/workbench/services/runtime/browser/browser-legacy-runtime-service";

describe("LegacyRuntimeService", () => {
  it("shares one readiness promise across concurrent callers", async () => {
    const service = new BrowserLegacyRuntimeService();

    const first = service.start();
    const concurrent = service.start();

    expect(concurrent).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(service.start()).toBe(first);
  });
});
