import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const url = new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url);
    return nextResolve(url.href, context);
  },
});

const {
  PROJECT_README_URL,
  createApplicationMenus,
  isEditingTarget,
  storedTheme,
  viewForImport,
  viewForNavigationShortcut,
} = await import("../src/appCommands.ts");
const { getJobAdmissionSettings, updateJobAdmissionSettings } = await import(
  "../src/features/settings/api.ts"
);

function keyboardEvent(
  key: string,
  target: EventTarget | null = null,
): Parameters<typeof viewForNavigationShortcut>[0] {
  return {
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key,
    target,
  };
}

test("application menu descriptors retain the five-menu contract", () => {
  const navigation: string[] = [];
  const imports: string[] = [];
  let toggledTheme = false;
  const menus = createApplicationMenus({
    theme: "light",
    canExportResult: false,
    canExitApplication: false,
    onNavigate: (view) => navigation.push(view),
    onImport: (target) => imports.push(target),
    onExportResult: () => undefined,
    onOpenSettings: () => undefined,
    onToggleTheme: () => {
      toggledTheme = true;
    },
    onOpenTutorial: () => undefined,
    onOpenAbout: () => undefined,
    onExitApplication: () => undefined,
  });

  assert.deepEqual(
    menus.map((menu) => menu.label),
    ["File", "Workflows", "Analysis", "Settings", "Help"],
  );
  const commands = menus.flatMap((menu) => menu.commands);
  commands.find((command) => command.id === "navigate-r2r")?.run();
  commands.find((command) => command.id === "import-motion-file")?.run();
  commands.find((command) => command.id === "toggle-theme")?.run();
  assert.deepEqual(navigation, ["r2r"]);
  assert.deepEqual(imports, ["motion-file"]);
  assert.equal(toggledTheme, true);
  assert.equal(
    commands.find((command) => command.id === "export-current-result")?.enabled,
    false,
  );
  assert.equal(
    commands.find((command) => command.id === "exit-application")?.enabled,
    false,
  );
  assert.equal(
    commands.find((command) => command.id === "toggle-theme")?.label,
    "Dark Mode",
  );
});

test("Alt+1 through Alt+7 navigate unless a form control is active", () => {
  assert.equal(viewForNavigationShortcut(keyboardEvent("1")), "motion");
  assert.equal(viewForNavigationShortcut(keyboardEvent("2")), "robot-assets");
  assert.equal(viewForNavigationShortcut(keyboardEvent("3")), "h2r");
  assert.equal(viewForNavigationShortcut(keyboardEvent("4")), "r2r");
  assert.equal(viewForNavigationShortcut(keyboardEvent("5")), "batch");
  assert.equal(viewForNavigationShortcut(keyboardEvent("6")), "dataset-viz");
  assert.equal(viewForNavigationShortcut(keyboardEvent("7")), "video-to-motion");
  assert.equal(
    viewForNavigationShortcut(
      keyboardEvent("3", { tagName: "INPUT" } as unknown as EventTarget),
    ),
    null,
  );
  assert.equal(
    viewForNavigationShortcut(
      keyboardEvent(
        "4",
        { tagName: "DIV", isContentEditable: true } as unknown as EventTarget,
      ),
    ),
    null,
  );
  assert.equal(isEditingTarget({ tagName: "textarea" } as unknown as EventTarget), true);
});

test("import intents select the owning persistent workspace", () => {
  assert.equal(viewForImport("motion-folder"), "motion");
  assert.equal(viewForImport("robot-mesh-folder"), "robot-assets");
  assert.equal(viewForImport("video-file"), "video-to-motion");
});

test("theme persistence accepts only the dark opt-in", () => {
  assert.equal(storedTheme({ getItem: () => "dark" }), "dark");
  assert.equal(storedTheme({ getItem: () => "unknown" }), "light");
  assert.equal(
    storedTheme({
      getItem: () => {
        throw new Error("storage unavailable");
      },
    }),
    "light",
  );
  assert.equal(
    PROJECT_README_URL,
    "https://github.com/Eleanor1018/human-humanoid-tools#readme",
  );
});

test("job-admission settings use the typed GET and PATCH contracts", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json({
      mode: "queued",
      max_running_jobs: 2,
      max_queued_jobs: 16,
      running_jobs: 1,
      queued_jobs: 3,
      reserved_jobs: 0,
      cancelling_jobs: 0,
      closed: false,
      editable: true,
    });
  };

  const before = await getJobAdmissionSettings({ fetcher });
  const after = await updateJobAdmissionSettings(
    { max_running_jobs: 2, max_queued_jobs: 16 },
    { fetcher },
  );

  assert.equal(before.running_jobs, 1);
  assert.equal(after.max_queued_jobs, 16);
  assert.equal(calls[0].url, "/api/settings/job-admission");
  assert.equal(calls[0].init?.method, undefined);
  assert.equal(calls[1].url, "/api/settings/job-admission");
  assert.equal(calls[1].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    max_running_jobs: 2,
    max_queued_jobs: 16,
  });
});
