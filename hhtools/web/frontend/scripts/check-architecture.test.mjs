import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditArchitecture } from "./check-architecture.mjs";

function createProject(t, files) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hhtools-architecture-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(projectRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
        lib: ["ES2022", "DOM"],
      },
      include: ["src/**/*.ts", "src/**/*.tsx"],
    }),
  );

  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  return projectRoot;
}

function audit(projectRoot, overrides = {}) {
  return auditArchitecture({
    projectRoot,
    importAllowlist: [],
    webApiBaseline: [],
    ...overrides,
  });
}

test("allows downward dependencies and rejects upward dependencies", (t) => {
  const projectRoot = createProject(t, {
    "src/base/common/value.ts": "export const value = 1;",
    "src/platform/tool/common/tool.ts": 'import { value } from "@/base/common/value"; export { value };',
    "src/workbench/services/jobs/common/job.ts":
      'import { value } from "@/platform/tool/common/tool"; export { value };',
    "src/workbench/browser/view.ts":
      'import { value } from "@/workbench/services/jobs/common/job"; export { value };',
    "src/base/common/bad.ts": 'export { value } from "@/platform/tool/common/tool";',
    "src/platform/tool/common/bad.ts":
      'const load = () => import("@/workbench/services/jobs/common/job"); export { load };',
  });

  const result = audit(projectRoot);
  assert.deepEqual(
    result.unexpectedImports.map(({ rule, source }) => [rule, source]),
    [
      ["upward-layer-import", "base/common/bad.ts"],
      ["upward-layer-import", "platform/tool/common/bad.ts"],
    ],
  );
});

test("common contracts cannot import browser implementations", (t) => {
  const projectRoot = createProject(t, {
    "src/platform/tool/browser/tool.ts": "export const tool = 1;",
    "src/platform/tool/common/tool.ts": 'export { tool } from "../browser/tool";',
  });

  const result = audit(projectRoot);
  assert.equal(result.unexpectedImports.length, 1);
  assert.equal(result.unexpectedImports[0].rule, "common-imports-browser");
});

test("only entrypoints load contributions and contributions cannot reach into the shell", (t) => {
  const projectRoot = createProject(t, {
    "src/workbench/services/jobs/common/job.ts": "export const job = 1;",
    "src/workbench/browser/shell.ts": "export const shell = 1;",
    "src/workbench/contrib/video/browser/view.ts": "export const view = 1;",
    "src/workbench/contrib/video/browser/good.ts":
      'export { job } from "@/workbench/services/jobs/common/job";',
    "src/workbench/contrib/video/browser/bad.ts":
      'export { shell } from "@/workbench/browser/shell";',
    "src/workbench/browser/bad.ts":
      'export { view } from "@/workbench/contrib/video/browser/view";',
    "src/main.tsx":
      'export { view } from "@/workbench/contrib/video/browser/view";',
  });

  const result = audit(projectRoot);
  assert.deepEqual(
    result.unexpectedImports.map(({ rule, source }) => [rule, source]).sort(),
    [
      ["contribution-imported-outside-entrypoint", "workbench/browser/bad.ts"],
      ["upward-layer-import", "workbench/contrib/video/browser/bad.ts"],
    ],
  );
});

test("contributions share only their explicit common contracts", (t) => {
  const projectRoot = createProject(t, {
    "src/workbench/contrib/video/common/video.ts":
      "export type VideoContract = { ready: boolean };",
    "src/workbench/contrib/video/browser/view.ts":
      "export const videoView = 1;",
    "src/workbench/contrib/video/browser/controller.ts":
      "export const videoController = 1;",
    "src/workbench/contrib/video/browser/own.ts":
      'export { videoController } from "./controller";',
    "src/workbench/contrib/analysis/browser/good.ts":
      'export type { VideoContract } from "@/workbench/contrib/video/common/video";',
    "src/workbench/contrib/analysis/browser/bad-view.ts":
      'export { videoView } from "@/workbench/contrib/video/browser/view";',
    "src/workbench/contrib/analysis/browser/bad-controller.ts":
      'export { videoController } from "@/workbench/contrib/video/browser/controller";',
  });

  const result = audit(projectRoot);
  assert.deepEqual(
    result.unexpectedImports.map(({ rule, source }) => [rule, source]),
    [
      [
        "cross-contribution-internal-import",
        "workbench/contrib/analysis/browser/bad-controller.ts",
      ],
      [
        "cross-contribution-internal-import",
        "workbench/contrib/analysis/browser/bad-view.ts",
      ],
    ],
  );
});

test("domain and workbench common contracts stay below services", (t) => {
  const projectRoot = createProject(t, {
    "src/base/common/value.ts": "export const value = 1;",
    "src/domain/motion/common/motion.ts":
      'export { value } from "@/base/common/value";',
    "src/workbench/common/views.ts":
      'export { value } from "@/domain/motion/common/motion";',
    "src/workbench/services/stage/common/stage.ts":
      'export { value } from "@/workbench/common/views";',
    "src/domain/motion/common/bad.ts":
      'export { value } from "@/workbench/services/stage/common/stage";',
  });

  const result = audit(projectRoot);
  assert.deepEqual(
    result.unexpectedImports.map(({ rule, source }) => [rule, source]),
    [["upward-layer-import", "domain/motion/common/bad.ts"]],
  );
});

test("legacy runtime edges require an exact allowlist entry", (t) => {
  const projectRoot = createProject(t, {
    "src/runtime/legacy.ts": "export const legacy = true;",
    "src/workbench/services/runtime/browser/adapter.ts":
      'import { legacy } from "@/runtime/legacy"; export { legacy };',
  });
  const allowlistEntry = {
    rule: "legacy-runtime-import",
    source: "workbench/services/runtime/browser/adapter.ts",
    target: "runtime/legacy.ts",
    reason: "Temporary adapter while the runtime is extracted.",
  };

  assert.equal(audit(projectRoot).ok, false);
  assert.equal(
    audit(projectRoot, { importAllowlist: [allowlistEntry] }).ok,
    true,
  );

  fs.writeFileSync(path.join(projectRoot, "src/workbench/services/runtime/browser/adapter.ts"), "export {};\n");
  const stale = audit(projectRoot, { importAllowlist: [allowlistEntry] });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.staleImportAllowlist, [allowlistEntry]);
});

test("legacy runtime uses workbench contracts only through an exact allowlist", (t) => {
  const projectRoot = createProject(t, {
    "src/workbench/common/workspace.ts": "export type Panel = 'motion';",
    "src/runtime/contracts.ts":
      'import type { Panel } from "@/workbench/common/workspace"; export type { Panel };',
  });
  const allowlistEntry = {
    rule: "legacy-imports-workbench",
    source: "runtime/contracts.ts",
    target: "workbench/common/workspace.ts",
    reason: "Temporary type-extraction seam.",
  };

  assert.equal(audit(projectRoot).ok, false);
  assert.equal(
    audit(projectRoot, { importAllowlist: [allowlistEntry] }).ok,
    true,
  );

  fs.writeFileSync(path.join(projectRoot, "src/runtime/contracts.ts"), "export {};\n");
  const stale = audit(projectRoot, { importAllowlist: [allowlistEntry] });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.staleImportAllowlist, [allowlistEntry]);
});

test("legacy runtime cannot reach workbench implementations or reverse common", (t) => {
  const projectRoot = createProject(t, {
    "src/workbench/services/jobs/common/job.ts": "export const job = 1;",
    "src/workbench/contrib/video/browser/view.ts": "export const view = 1;",
    "src/workbench/browser/shell.ts": "export const shell = 1;",
    "src/workbench/common/bad.ts":
      'import { legacy } from "@/runtime/legacy"; export { legacy };',
    "src/runtime/legacy.ts": "export const legacy = 1;",
    "src/runtime/service.ts":
      'import { job } from "@/workbench/services/jobs/common/job"; export { job };',
    "src/runtime/contribution.ts":
      'import { view } from "@/workbench/contrib/video/browser/view"; export { view };',
    "src/runtime/browser.ts":
      'import { shell } from "@/workbench/browser/shell"; export { shell };',
  });

  const result = audit(projectRoot);
  assert.deepEqual(
    result.unexpectedImports.map(({ rule, source }) => [rule, source]),
    [
      ["legacy-imports-workbench", "runtime/browser.ts"],
      ["legacy-imports-workbench", "runtime/contribution.ts"],
      ["legacy-imports-workbench", "runtime/service.ts"],
      ["legacy-runtime-import", "workbench/common/bad.ts"],
    ],
  );
});

test("detects real global transport APIs without matching text or shadowed names", (t) => {
  const projectRoot = createProject(t, {
    "src/runtime/legacy.ts": `
      const words = "fetch('/not-code') and new XMLHttpRequest()";
      function localScope(fetch) { fetch(); }
      globalThis.fetch('/one');
      window['fetch']('/two');
      new XMLHttpRequest();
      export { words, localScope };
    `,
    "src/platform/request/browser/request.ts": `
      fetch('/allowed');
      new XMLHttpRequest();
    `,
  });

  const result = audit(projectRoot);
  assert.deepEqual(
    result.webApiMismatches.map(({ file, api, actual }) => [file, api, actual]),
    [
      ["runtime/legacy.ts", "XMLHttpRequest", 1],
      ["runtime/legacy.ts", "fetch", 2],
    ],
  );

  const withBaseline = audit(projectRoot, {
    webApiBaseline: [
      { file: "runtime/legacy.ts", api: "fetch", count: 2, reason: "Legacy transport." },
      { file: "runtime/legacy.ts", api: "XMLHttpRequest", count: 1, reason: "Legacy progress." },
    ],
  });
  assert.equal(withBaseline.ok, true);
});

test("transport baseline changes in either direction require review", (t) => {
  const projectRoot = createProject(t, {
    "src/runtime/legacy.ts": "fetch('/one');\n",
  });
  const baseline = [
    { file: "runtime/legacy.ts", api: "fetch", count: 2, reason: "Migration debt." },
  ];

  const result = audit(projectRoot, { webApiBaseline: baseline });
  assert.equal(result.ok, false);
  assert.deepEqual(result.webApiMismatches[0], {
    file: "runtime/legacy.ts",
    api: "fetch",
    actual: 1,
    expected: 2,
    usages: result.webApiMismatches[0].usages,
  });
});
