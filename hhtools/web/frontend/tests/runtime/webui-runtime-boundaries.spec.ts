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
});
