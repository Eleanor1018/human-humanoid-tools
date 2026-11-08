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

const { getSolvers } = await import("../src/lib/solvers.ts");

test("solver list keeps well-formed entries and normalizes optional fields", async () => {
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        solvers: [
          { id: "newton", label: "Newton IK", available: true, experimental: false },
          {
            id: "frax",
            label: "FRAX differential IK (experimental)",
            available: false,
            experimental: true,
            categories: ["plain_motion"],
            reason: "missing dependencies: frax",
          },
          { id: 3, available: true },
          null,
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const solvers = await getSolvers({ fetcher });

  assert.deepEqual(calls, ["/api/solvers"]);
  assert.deepEqual(
    solvers.map((solver) => [solver.id, solver.available, solver.experimental]),
    [
      ["newton", true, false],
      ["frax", false, true],
    ],
  );
  assert.equal(solvers[0].reason, null);
  assert.deepEqual(solvers[0].categories, []);
  assert.equal(solvers[1].reason, "missing dependencies: frax");
});

test("a malformed solver payload yields no solvers", async () => {
  const fetcher = async () =>
    new Response(JSON.stringify({ solvers: "nope" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  assert.deepEqual(await getSolvers({ fetcher }), []);
});
