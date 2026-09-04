/** Installation state reported by the desktop host for the optional GVHMR runtime. */
export interface GvhmrOptionalComponentState {
  requested: boolean;
  configured: boolean;
  root?: string;
  guideUrl: string;
  estimatedAdditionalBytes: number;
}

/** Outcome of the native GVHMR setup flow. */
export interface GvhmrSetupResult {
  action: "cancelled" | "configured" | "guide-opened";
  state: GvhmrOptionalComponentState;
}

/**
 * Optional GVHMR component capability exposed to the workbench.
 *
 * A normal browser has no native installer, so both operations resolve to
 * `null` there. Desktop renderers delegate to the typed preload bridge.
 */
export interface IGvhmrComponentService {
  getState(): Promise<GvhmrOptionalComponentState | null>;
  setup(): Promise<GvhmrSetupResult | null>;
}
