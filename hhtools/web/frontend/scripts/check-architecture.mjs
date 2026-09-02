#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * These entries are migration debt, not exceptions for future code. Each entry
 * names one exact source/target edge so moving or removing it forces the
 * baseline to shrink instead of silently leaving a wildcard behind.
 */
const LEGACY_RUNTIME_TYPE_CONSUMERS = [
  "env.d.ts",
  "workbench/browser/components/batch-workflow.tsx",
  "workbench/browser/components/calibration-editor-controls.tsx",
  "workbench/browser/components/data-analysis-pipeline.tsx",
  "workbench/browser/components/job-drawer.tsx",
  "workbench/browser/components/motion-panel.tsx",
  "workbench/browser/components/motion-picker-dialog.tsx",
  "workbench/browser/components/pipeline-nav.tsx",
  "workbench/browser/components/playback-bar.tsx",
  "workbench/browser/components/result-evaluation-panel.tsx",
  "workbench/browser/components/video-to-motion-pipeline.tsx",
  "workbench/browser/components/workflow-pipeline.tsx",
  "workbench/browser/components/workspace-settings-dialog.tsx",
  "workbench/browser/use-video-batch.ts",
  "workbench/browser/workbench.tsx",
  "workbench/services/jobs/browser/browser-job-service.ts",
  "workbench/services/jobs/common/job-service.ts",
  "workbench/services/settings/browser/browser-settings-service.ts",
  "workbench/services/settings/common/settings-service.ts",
];

export const LEGACY_IMPORT_ALLOWLIST = [
  ...LEGACY_RUNTIME_TYPE_CONSUMERS.map((source) => ({
    rule: "legacy-runtime-import",
    source,
    target: "runtime/types.ts",
    reason: "Legacy bridge DTOs still await extraction into their owning common service modules.",
  })),
  {
    rule: "legacy-runtime-import",
    source: "env.d.ts",
    target: "runtime/tutorial.ts",
    reason: "The legacy window bridge still publishes the tutorial controller type.",
  },
  {
    rule: "legacy-runtime-import",
    source: "workbench/browser/components/application-chrome.tsx",
    target: "runtime/command-registry.ts",
    reason: "Application chrome still adapts commands registered by the legacy runtime.",
  },
  ...[
    "workbench/browser/components/result-evaluation-panel.tsx",
    "workbench/browser/workbench.tsx",
  ].map((source) => ({
    rule: "legacy-runtime-import",
    source,
    target: "runtime/workspace-preferences.ts",
    reason: "Workspace preferences have not yet moved behind ISettingsService.",
  })),
  ...["runtime/dataset-viz.ts", "runtime/webui-runtime.ts"].map((target) => ({
    rule: "legacy-runtime-import",
    source: "workbench/services/runtime/browser/browser-legacy-runtime-service.ts",
    target,
    reason: "This adapter is the intentional dynamic-import boundary around the legacy runtime.",
  })),
  ...[
    "runtime/command-registry.ts",
    "runtime/types.ts",
    "runtime/workspace-preferences.ts",
  ].map((source) => ({
    rule: "legacy-imports-workbench",
    source,
    target: "workbench/common/workspace.ts",
    reason: "Legacy runtime modules consume the extracted workspace identity contract until they are removed.",
  })),
];

/**
 * Legacy runtime code still performs transport work directly. Counts are kept
 * per file and API: increasing or decreasing one requires an explicit baseline
 * change, which makes both regressions and migration progress visible in review.
 */
export const LEGACY_WEB_API_BASELINE = [
  {
    file: "runtime/dataset-viz.ts",
    api: "fetch",
    count: 2,
    reason: "Dataset export requests have not yet moved to IRequestService.",
  },
  {
    file: "runtime/webui-runtime.ts",
    api: "fetch",
    count: 7,
    reason: "The legacy runtime still owns several request paths during incremental extraction.",
  },
  {
    file: "runtime/webui-runtime.ts",
    api: "XMLHttpRequest",
    count: 1,
    reason: "The legacy upload path still uses XHR for progress reporting.",
  },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const LAYER_RANK = new Map([
  ["base", 0],
  ["domain", 1],
  ["platform", 1],
  ["workbench-common", 2],
  ["workbench-services", 2],
  ["workbench-contrib", 3],
  ["workbench-browser", 4],
  ["entrypoint", 5],
]);
const WEB_API_NAMES = new Set(["fetch", "XMLHttpRequest"]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeSourcePath(sourceRoot, fileName) {
  return toPosix(path.relative(sourceRoot, fileName));
}

function classifyLayer(file) {
  if (
    file.startsWith("base/") ||
    file.startsWith("components/ui/") ||
    file.startsWith("lib/")
  ) {
    return "base";
  }
  if (file.startsWith("domain/")) return "domain";
  if (file.startsWith("platform/")) return "platform";
  if (file.startsWith("workbench/common/")) return "workbench-common";
  if (file.startsWith("workbench/services/")) return "workbench-services";
  if (file.startsWith("workbench/contrib/")) return "workbench-contrib";
  if (file.startsWith("workbench/browser/") || file.startsWith("hooks/")) {
    return "workbench-browser";
  }
  if (file.startsWith("runtime/")) return "legacy-runtime";
  if (/^main(?:\.[^/]+)?\.tsx?$/.test(file)) return "entrypoint";
  return "unclassified";
}

function hasPathSegment(file, segment) {
  return file.split("/").includes(segment);
}

function importRuleFor(source, target) {
  const sourceLayer = classifyLayer(source);
  const targetLayer = classifyLayer(target);

  // Legacy runtime is deliberately outside the new layer graph. Any remaining
  // reference to it must be an exact, reviewable migration seam.
  if (sourceLayer !== "legacy-runtime" && targetLayer === "legacy-runtime") {
    return "legacy-runtime-import";
  }

  // The compatibility runtime must not acquire new dependencies on its React
  // replacement. Even common-contract migration seams stay exact and reviewable.
  if (sourceLayer === "legacy-runtime" && targetLayer.startsWith("workbench-")) {
    return "legacy-imports-workbench";
  }

  // Feature implementation is loaded by the composition entry point and
  // contributes descriptors to the shell. Core/services must never import a
  // concrete contribution, otherwise adding a feature changes the framework.
  if (
    targetLayer === "workbench-contrib" &&
    sourceLayer !== "workbench-contrib" &&
    sourceLayer !== "entrypoint"
  ) {
    return "contribution-imported-outside-entrypoint";
  }

  // Nothing inside the product may depend back on its composition root.
  if (targetLayer === "entrypoint" && sourceLayer !== "entrypoint") {
    return "imports-entrypoint";
  }

  // A common contract must remain loadable without DOM/Web APIs. This check is
  // independent of the vertical layer because it protects runtime portability.
  if (hasPathSegment(source, "common") && hasPathSegment(target, "browser")) {
    return "common-imports-browser";
  }

  const sourceRank = LAYER_RANK.get(sourceLayer);
  const targetRank = LAYER_RANK.get(targetLayer);
  const lowerLayerAllowedTargets = {
    base: new Set(["base"]),
    domain: new Set(["base", "domain"]),
    platform: new Set(["base", "platform"]),
    "workbench-common": new Set(["base", "domain", "platform", "workbench-common"]),
    "workbench-services": new Set([
      "base",
      "domain",
      "platform",
      "workbench-common",
      "workbench-services",
    ]),
  };
  const allowedTargets = lowerLayerAllowedTargets[sourceLayer];
  if (allowedTargets && !allowedTargets.has(targetLayer)) {
    return "upward-layer-import";
  }
  if (sourceRank !== undefined && targetRank !== undefined && sourceRank < targetRank) {
    return "upward-layer-import";
  }

  return undefined;
}

function collectModuleSpecifiers(sourceFile) {
  const specifiers = [];

  const add = (literal) => {
    if (literal && ts.isStringLiteralLike(literal)) {
      const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
      specifiers.push({
        specifier: literal.text,
        line: position.line + 1,
        column: position.character + 1,
      });
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      add(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node.argument.literal);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function resolveInternalImport(specifier, containingFile, compilerOptions, sourceRoot) {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys,
  ).resolvedModule;

  if (!resolved) return undefined;

  const fileName = path.resolve(resolved.resolvedFileName);
  if (!isInside(sourceRoot, fileName) || !SOURCE_EXTENSIONS.has(path.extname(fileName))) {
    return undefined;
  }

  return relativeSourcePath(sourceRoot, fileName);
}

function isPropertyName(node) {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
      parent.name === node)
  );
}

function isGlobalDomIdentifier(node, checker) {
  if (!ts.isIdentifier(node) || !WEB_API_NAMES.has(node.text) || isPropertyName(node)) {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(node);
  return Boolean(
    symbol?.declarations?.some((declaration) => {
      const declarationFile = declaration.getSourceFile();
      return declarationFile.hasNoDefaultLib && /lib\.(dom|webworker).*\.d\.ts$/i.test(declarationFile.fileName);
    }),
  );
}

function rootExpressionName(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function webApiFromPropertyAccess(node) {
  if (ts.isPropertyAccessExpression(node)) {
    const name = node.name.text;
    if (WEB_API_NAMES.has(name) && ["window", "globalThis", "self"].includes(rootExpressionName(node))) {
      return name;
    }
  }

  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    const name = node.argumentExpression.text;
    if (WEB_API_NAMES.has(name) && ["window", "globalThis", "self"].includes(rootExpressionName(node))) {
      return name;
    }
  }

  return undefined;
}

function collectWebApiUsages(sourceFile, checker, sourceRoot) {
  const file = relativeSourcePath(sourceRoot, sourceFile.fileName);
  if (file.startsWith("platform/request/")) return [];

  const usages = [];
  const visit = (node) => {
    const propertyApi = webApiFromPropertyAccess(node);
    const identifierApi = isGlobalDomIdentifier(node, checker) ? node.text : undefined;
    const api = propertyApi ?? identifierApi;

    if (api) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      usages.push({
        file,
        api,
        line: position.line + 1,
        column: position.character + 1,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return usages;
}

function importKey(entry) {
  return `${entry.rule}\0${entry.source}\0${entry.target}`;
}

function webApiKey(entry) {
  return `${entry.file}\0${entry.api}`;
}

function validateBaseline(importAllowlist, webApiBaseline) {
  const importKeys = new Set();
  for (const entry of importAllowlist) {
    if (!entry.reason || entry.reason.includes("TODO")) {
      throw new Error(`Legacy import ${entry.source} -> ${entry.target} needs a concrete reason.`);
    }
    if ([entry.source, entry.target].some((value) => /[*?]/.test(value))) {
      throw new Error(`Legacy import allowlist entries must use exact paths: ${entry.source} -> ${entry.target}`);
    }
    const key = importKey(entry);
    if (importKeys.has(key)) {
      throw new Error(`Duplicate legacy import allowlist entry: ${entry.source} -> ${entry.target}`);
    }
    importKeys.add(key);
  }

  const apiKeys = new Set();
  for (const entry of webApiBaseline) {
    if (!entry.reason || entry.reason.includes("TODO")) {
      throw new Error(`Transport baseline ${entry.file} ${entry.api} needs a concrete reason.`);
    }
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      throw new Error(`Transport baseline ${entry.file} ${entry.api} needs a positive integer count.`);
    }
    const key = webApiKey(entry);
    if (apiKeys.has(key)) {
      throw new Error(`Duplicate transport baseline entry: ${entry.file} ${entry.api}`);
    }
    apiKeys.add(key);
  }
}

function parseProject(projectRoot) {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`No tsconfig.json found under ${projectRoot}`);
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"),
    );
  }

  return {
    compilerOptions: parsed.options,
    program: ts.createProgram(parsed.fileNames, parsed.options),
  };
}

/**
 * Audits the project without mutating it. Tests pass their own baseline so the
 * production debt ledger remains a simple, reviewable constant above.
 */
export function auditArchitecture({
  projectRoot,
  importAllowlist = LEGACY_IMPORT_ALLOWLIST,
  webApiBaseline = LEGACY_WEB_API_BASELINE,
}) {
  validateBaseline(importAllowlist, webApiBaseline);
  const absoluteProjectRoot = path.resolve(projectRoot);
  const sourceRoot = path.join(absoluteProjectRoot, "src");
  const { compilerOptions, program } = parseProject(absoluteProjectRoot);
  const checker = program.getTypeChecker();
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) => isInside(sourceRoot, path.resolve(sourceFile.fileName)));

  const imports = [];
  const webApiUsages = [];
  for (const sourceFile of sourceFiles) {
    const source = relativeSourcePath(sourceRoot, sourceFile.fileName);
    for (const item of collectModuleSpecifiers(sourceFile)) {
      const target = resolveInternalImport(
        item.specifier,
        sourceFile.fileName,
        compilerOptions,
        sourceRoot,
      );
      if (target) imports.push({ source, target, ...item });
    }
    webApiUsages.push(...collectWebApiUsages(sourceFile, checker, sourceRoot));
  }

  const violationByKey = new Map();
  for (const item of imports) {
    const rule = importRuleFor(item.source, item.target);
    if (!rule) continue;
    const violation = { rule, ...item };
    if (!violationByKey.has(importKey(violation))) {
      violationByKey.set(importKey(violation), violation);
    }
  }

  const importViolations = [...violationByKey.values()].sort((left, right) =>
    compareText(importKey(left), importKey(right)),
  );
  const allowlistByKey = new Map(importAllowlist.map((entry) => [importKey(entry), entry]));
  const actualImportKeys = new Set(importViolations.map(importKey));
  const unexpectedImports = importViolations.filter((entry) => !allowlistByKey.has(importKey(entry)));
  const staleImportAllowlist = importAllowlist.filter((entry) => !actualImportKeys.has(importKey(entry)));

  const usageGroups = new Map();
  for (const usage of webApiUsages) {
    const key = webApiKey(usage);
    const group = usageGroups.get(key) ?? { file: usage.file, api: usage.api, usages: [] };
    group.usages.push(usage);
    usageGroups.set(key, group);
  }

  const baselineByKey = new Map(webApiBaseline.map((entry) => [webApiKey(entry), entry]));
  const allUsageKeys = new Set([...usageGroups.keys(), ...baselineByKey.keys()]);
  const webApiMismatches = [...allUsageKeys]
    .map((key) => {
      const group = usageGroups.get(key);
      const baseline = baselineByKey.get(key);
      const actual = group?.usages.length ?? 0;
      const expected = baseline?.count ?? 0;
      return actual === expected
        ? undefined
        : {
            file: group?.file ?? baseline.file,
            api: group?.api ?? baseline.api,
            actual,
            expected,
            usages: group?.usages ?? [],
          };
    })
    .filter(Boolean)
    .sort((left, right) => compareText(webApiKey(left), webApiKey(right)));

  return {
    sourceFileCount: sourceFiles.length,
    internalImportCount: imports.length,
    importViolations,
    unexpectedImports,
    staleImportAllowlist,
    webApiUsages,
    webApiMismatches,
    ok:
      unexpectedImports.length === 0 &&
      staleImportAllowlist.length === 0 &&
      webApiMismatches.length === 0,
  };
}

export function suggestedBaseline(result) {
  const importAllowlist = result.importViolations.map(({ rule, source, target }) => ({
    rule,
    source,
    target,
    reason: "TODO: document the migration seam",
  }));

  const grouped = new Map();
  for (const usage of result.webApiUsages) {
    const key = webApiKey(usage);
    const entry = grouped.get(key) ?? {
      file: usage.file,
      api: usage.api,
      count: 0,
      reason: "TODO: migrate transport access to platform/request",
    };
    entry.count += 1;
    grouped.set(key, entry);
  }

  return {
    importAllowlist,
    webApiBaseline: [...grouped.values()].sort((left, right) =>
      compareText(webApiKey(left), webApiKey(right)),
    ),
  };
}

export function formatAuditFailure(result) {
  const lines = ["Architecture boundary check failed."];

  if (result.unexpectedImports.length > 0) {
    lines.push("", "Unexpected dependency edges:");
    for (const item of result.unexpectedImports) {
      lines.push(
        `- [${item.rule}] ${item.source}:${item.line}:${item.column} -> ${item.target}`,
      );
    }
  }

  if (result.staleImportAllowlist.length > 0) {
    lines.push("", "Stale legacy allowlist entries (remove them to ratchet the boundary):");
    for (const item of result.staleImportAllowlist) {
      lines.push(`- [${item.rule}] ${item.source} -> ${item.target}`);
    }
  }

  if (result.webApiMismatches.length > 0) {
    lines.push("", "Direct transport API baseline mismatches:");
    for (const item of result.webApiMismatches) {
      const locations = item.usages.map((usage) => `${usage.line}:${usage.column}`).join(", ");
      lines.push(
        `- ${item.file} ${item.api}: expected ${item.expected}, found ${item.actual}` +
          (locations ? ` (${locations})` : ""),
      );
    }
  }

  lines.push(
    "",
    "New transport calls belong under src/platform/request/. Update the baseline only when a reviewed migration intentionally changes existing debt.",
  );
  return lines.join("\n");
}

function runCli() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDirectory, "..");
  const printBaseline = process.argv.includes("--print-baseline");
  const result = auditArchitecture({
    projectRoot,
    importAllowlist: printBaseline ? [] : LEGACY_IMPORT_ALLOWLIST,
    webApiBaseline: printBaseline ? [] : LEGACY_WEB_API_BASELINE,
  });

  if (printBaseline) {
    process.stdout.write(`${JSON.stringify(suggestedBaseline(result), null, 2)}\n`);
    return;
  }

  if (!result.ok) {
    process.stderr.write(`${formatAuditFailure(result)}\n`);
    process.exitCode = 1;
    return;
  }

  const frozenTransportUses = LEGACY_WEB_API_BASELINE.reduce(
    (total, entry) => total + entry.count,
    0,
  );
  process.stdout.write(
    `Architecture boundaries OK (${result.sourceFileCount} source files, ` +
      `${result.internalImportCount} internal imports, ` +
      `${LEGACY_IMPORT_ALLOWLIST.length} frozen legacy edges, ` +
      `${frozenTransportUses} frozen direct transport uses).\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli();
}
