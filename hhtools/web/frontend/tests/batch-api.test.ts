import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const extension = specifier.endsWith(".ts") ? "" : ".ts";
    const url = new URL(`../src/${specifier.slice(2)}${extension}`, import.meta.url);
    return nextResolve(url.href, context);
  },
});

const {
  batchDownloadUrl,
  runHumanBatch,
  runR2rBatch,
  scanHumanBatchInputs,
  uploadR2rBatchInputs,
} = await import("../src/features/batch/api.ts");

test("H2R Batch sends entries and returns its download identity", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const completed = await runHumanBatch(
    {
      robot: "g1_29dof",
      entries: [{ source_path: "/motions/walk.bvh", reference: "smpl" }],
      reference: "smpl",
      backend: "newton",
      out_dir: "batch_export",
      format: "csv",
      csv_header: true,
      foot_clamp_anti_penetration: false,
      batch_size: 8,
    },
    {
      pollIntervalMs: 0,
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        if (calls.length === 1) return Response.json({ job_id: "batch-job" });
        return Response.json({
          id: "batch-job",
          kind: "batch",
          status: "done",
          result: {
            written: ["walk.csv"],
            errors: [],
            failures: [],
            format: "csv",
            download_name: "batch_export.zip",
            artifact_path: "/tmp/batch_export.zip",
          },
        });
      },
    },
  );
  assert.equal(completed.jobId, "batch-job");
  assert.equal(completed.result.written.length, 1);
  assert.equal(batchDownloadUrl(completed.jobId), "/api/job/batch-job/download");
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/batch/retarget",
    "/api/job/batch-job",
  ]);
  assert.equal(JSON.parse(String(calls[0].init?.body)).batch_size, 8);
});

test("R2R Batch enforces its dedicated job kind", async () => {
  const completed = await runR2rBatch(
    {
      source: "roboto_origin",
      target: "g1_29dof",
      entries: [{ source_path: "/robot/walk.csv" }],
      backend: "interaction_mesh",
      out_dir: "r2r_batch_export",
      format: "pkl",
      csv_header: false,
    },
    {
      pollIntervalMs: 0,
      fetcher: async (input) =>
        String(input) === "/api/r2r/batch/retarget"
          ? Response.json({ job_id: "r2r-batch-job" })
          : Response.json({
              id: "r2r-batch-job",
              kind: "r2r_batch",
              status: "done",
              result: {
                written: [],
                errors: ["walk failed"],
                failures: [{ stem: "walk", stage: "retarget", reason: "failed" }],
                format: "pkl",
                download_name: "r2r_batch_export.zip",
                artifact_path: "/tmp/r2r_batch_export.zip",
              },
            }),
    },
  );
  assert.equal(completed.result.failures[0]?.stem, "walk");
});

test("Batch scan and upload keep their separate input contracts", async () => {
  let scanBody: unknown;
  const scanned = await scanHumanBatchInputs("/data/motions", "auto", {
    fetcher: async (_input, init) => {
      scanBody = JSON.parse(String(init?.body));
      return Response.json({ entries: [], clip_count: 0, source: "/data/motions" });
    },
  });
  assert.deepEqual(scanBody, { source: "/data/motions", profile: "auto" });
  assert.equal(scanned.source, "/data/motions");

  const uploaded = await uploadR2rBatchInputs(
    [new File(["q"], "walk.csv")],
    "mimic",
    {
      pollIntervalMs: 0,
      fetcher: async (input) =>
        String(input).startsWith("/api/r2r/basket/upload")
          ? Response.json({ job_id: "upload-job" })
          : Response.json({
              id: "upload-job",
              kind: "r2r_basket_upload",
              status: "done",
              result: { entries: [{ source_path: "/tmp/walk.csv" }], clip_count: 1 },
            }),
    },
  );
  assert.equal(uploaded.entries[0]?.source_path, "/tmp/walk.csv");
});

