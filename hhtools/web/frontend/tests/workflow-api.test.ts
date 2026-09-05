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

const { retarget: runH2rRetarget, retargetExportUrl } =
  await import("../src/features/h2r/api.ts");
const { getR2rLibrary, r2rExportUrl, runR2rRetarget } =
  await import("../src/features/r2r/api.ts");

test("H2R preserves the selected backend and polls its retarget job", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await runH2rRetarget(
    {
      robot: "g1_29dof",
      motion_token: "motion-token",
      reference: "smpl",
      backend: "newton",
      retarget_fps: 60,
    },
    {
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        if (calls.length === 1) return Response.json({ job_id: "h2r-job" });
        return Response.json({
          id: "h2r-job",
          kind: "retarget",
          status: "done",
          progress: 1,
          result: {
            trajectory: { frames: [] },
            export_token: "h2r-export",
            num_frames: 12,
          },
        });
      },
    },
  );

  assert.deepEqual(
    calls.map((call) => call.url),
    ["/api/retarget", "/api/job/h2r-job"],
  );
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    robot: "g1_29dof",
    motion_token: "motion-token",
    reference: "smpl",
    backend: "newton",
    retarget_fps: 60,
    foot_clamp_anti_penetration: false,
  });
  assert.equal(result.export_token, "h2r-export");
});

test("R2R library accepts only entries explicitly marked robot_trajectory", async () => {
  const entries = await getR2rLibrary({
    fetcher: async () =>
      Response.json({
        source_root: "/source",
        motions_library_root: "/library",
        folders: [],
        entries: [
          { source_path: "/robot.csv", asset_kind: "robot_trajectory" },
          { source_path: "/human.bvh", asset_kind: "human_motion" },
          { source_path: "/unknown.npz" },
        ],
      }),
  });

  assert.deepEqual(
    entries.map((entry) => entry.source_path),
    ["/robot.csv"],
  );
});

test("R2R sends the retarget contract and enforces the r2r job kind", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return Response.json({ job_id: "r2r-job" });
    return Response.json({
      id: "r2r-job",
      kind: "r2r_retarget",
      status: "done",
      result: {
        trajectory: { frames: [] },
        export_token: "r2r-export",
        stem: "walk",
        num_frames: 8,
        source_fps: 24,
      },
    });
  };

  await runR2rRetarget(
    {
      target: "g1_29dof",
      source: "roboto_origin",
      sourceToken: "source-token",
      backend: "interaction_mesh",
      retargetFps: 24,
    },
    { fetcher, pollIntervalMs: 0 },
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    ["/api/r2r/retarget", "/api/job/r2r-job"],
  );
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    target: "g1_29dof",
    source: "roboto_origin",
    source_token: "source-token",
    backend: "interaction_mesh",
    retarget_fps: 24,
  });

  await assert.rejects(
    runR2rRetarget(
      {
        target: "g1_29dof",
        source: "roboto_origin",
        sourceToken: "source-token",
        backend: "newton",
      },
      {
        pollIntervalMs: 0,
        fetcher: async (input) =>
          String(input) === "/api/r2r/retarget"
            ? Response.json({ job_id: "wrong-kind" })
            : Response.json({
                id: "wrong-kind",
                kind: "retarget",
                status: "done",
                result: {},
              }),
      },
    ),
    /expected r2r_retarget/,
  );
});

test("workflow export URLs encode tokens and requested options", () => {
  const h2r = new URL(
    retargetExportUrl("h2r token/1", {
      format: "pkl",
      fps: 60,
      csvHeader: false,
      start: 1.25,
      end: 2.5,
    }),
    "http://localhost",
  );
  assert.equal(h2r.pathname, "/api/export/h2r%20token%2F1");
  assert.deepEqual(Object.fromEntries(h2r.searchParams), {
    fmt: "pkl",
    fps: "60",
    csv_header: "0",
    t_start: "1.25",
    t_end: "2.5",
  });

  const r2r = new URL(
    r2rExportUrl("r2r token", { format: "csv", fps: 30, csvHeader: false }),
    "http://localhost",
  );
  assert.equal(r2r.pathname, "/api/export/r2r%20token");
  assert.deepEqual(Object.fromEntries(r2r.searchParams), {
    fmt: "csv",
    csv_header: "false",
    fps: "30",
  });
});
