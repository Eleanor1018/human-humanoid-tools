import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("right-side workspace panels are imported and mounted eagerly", () => {
  assert.doesNotMatch(appSource, /\blazy\s*\(/);
  assert.doesNotMatch(appSource, /\bSuspense\b/);
  assert.doesNotMatch(appSource, /mountedViews/);

  for (const view of [
    "AnalysisView",
    "BatchView",
    "HumanToRobotView",
    "RobotToRobotView",
    "RobotView",
    "VideoToMotionView",
  ]) {
    assert.match(appSource, new RegExp(`import \\{ ${view} \\}`));
  }
});
