import { describe, expect, it } from "vitest";

import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";

describe("legacy runtime ownership boundaries", () => {
  it("lets the React-owned V2M batch dropzone handle its own files", () => {
    const stageDropzone = runtimeSource.slice(
      runtimeSource.indexOf("initGvhmrWorkspace();"),
      runtimeSource.indexOf('document.getElementById("add-to-basket")'),
    );

    expect(stageDropzone).toContain('target.closest("#v2m-batch-drop")');
  });

  it("presents generated motion through one ordered aggregate boundary", () => {
    const start = runtimeSource.indexOf(
      "export async function presentHumanMotion",
    );
    const end = runtimeSource.indexOf("function datasetSceneGlbUrl", start);
    const facade = runtimeSource.slice(start, end);
    const load = facade.indexOf("await loadMotionPayload(payload)");
    const refresh = facade.indexOf("await refreshLibrary()");
    const basket = facade.indexOf("addToBasket([payload.library_entry]");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(load).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(load);
    expect(basket).toBeGreaterThan(refresh);
    expect(facade).toContain("{ silent: true }");

    const legacyFlow = runtimeSource.slice(
      runtimeSource.indexOf("async function runGvhmrVideoToMotion"),
      runtimeSource.indexOf("function initGvhmrWorkspace"),
    );
    expect(legacyFlow).toContain("await presentHumanMotion(payload)");
  });
});
