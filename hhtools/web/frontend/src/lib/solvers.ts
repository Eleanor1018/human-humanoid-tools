/** Retarget solver availability (GET /api/solvers), shared by the workflow views. */

import { useEffect, useState } from "react";

import { requestJson, type Fetcher } from "@/lib/api";
import { createRequestCache } from "@/lib/requestCache";

export interface SolverInfo {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly experimental: boolean;
  readonly categories: readonly string[];
  readonly reason: string | null;
}

const solverCache = createRequestCache<readonly SolverInfo[]>(60_000);

function isSolverInfo(value: unknown): value is SolverInfo {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.available === "boolean";
}

/** Read the solver list; unknown or malformed entries are dropped. */
export async function getSolvers(
  options: { readonly signal?: AbortSignal; readonly fetcher?: Fetcher } = {},
): Promise<readonly SolverInfo[]> {
  const load = async (signal?: AbortSignal, fetcher?: Fetcher) => {
    const response = await requestJson<{ solvers?: unknown }>(
      "/api/solvers",
      { signal },
      fetcher,
    );
    return Array.isArray(response.solvers)
      ? response.solvers.filter(isSolverInfo).map((item) => ({
          id: item.id,
          label: typeof item.label === "string" ? item.label : item.id,
          available: item.available,
          experimental: item.experimental === true,
          categories: Array.isArray(item.categories) ? item.categories : [],
          reason: typeof item.reason === "string" ? item.reason : null,
        }))
      : [];
  };
  if (options.fetcher) return load(options.signal, options.fetcher);
  return solverCache.read(() => load(), options.signal);
}

/**
 * Whether the optional FRAX solver is installed.  ``false`` until the server
 * answers, so the option only appears when it can actually run.
 */
export function useFraxAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getSolvers({ signal: controller.signal })
      .then((solvers) => {
        setAvailable(solvers.some((solver) => solver.id === "frax" && solver.available));
      })
      .catch(() => setAvailable(false));
    return () => controller.abort();
  }, []);
  return available;
}
