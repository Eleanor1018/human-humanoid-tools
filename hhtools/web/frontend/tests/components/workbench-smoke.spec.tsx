import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/runtime/webui-runtime", () => ({}));
vi.mock("../../src/runtime/dataset-viz", () => ({}));

import { Workbench } from "../../src/workbench/browser/workbench";
import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";

afterEach(() => cleanup());

describe("Workbench DOM contract", () => {
  it("mounts every runtime contribution before the compatibility service starts", () => {
    render(<Workbench />);
    const ids = [
      "three-canvas",
      "motion-drop-shared",
      "video-pick-file",
      "robot-pick-urdf",
      "h2r-robot-select",
      "retarget-btn",
      "r2r-source-select",
      "r2r-retarget-btn",
      "basket-list",
      "batch-run",
      "r2r-basket-list",
      "r2r-batch-run",
      "dv-pick-folder",
      "dv-hist-canvas",
      "dv-scatter-canvas",
    ];
    for (const id of ids)
      expect(document.getElementById(id), id).not.toBeNull();
  });

  it("preserves every literal element id consumed by the existing runtime", () => {
    render(<Workbench />);
    const requiredIds = [
      ...runtimeSource.matchAll(/getElementById\("([^"]+)"\)/g),
    ].map((match) => match[1]);
    const missingIds = [...new Set(requiredIds)].filter(
      (id) => document.getElementById(id) === null,
    );
    expect(missingIds).toEqual([]);
  });
});
