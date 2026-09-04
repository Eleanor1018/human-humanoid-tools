/**
 * Result shared by compatibility Stage Views whose resources finish loading
 * asynchronously. A stale load was deliberately superseded by clear() or a
 * newer load; it is not a transport or decode failure.
 */
export type AsyncStageViewLoadResult = "committed" | "stale";
