/**
 * Installation state reported by the desktop preload for the optional GVHMR
 * runtime. This is a host capability contract, not React or legacy-runtime
 * state, so lower platform adapters can depend on it without importing upward.
 */
export interface GvhmrOptionalComponentState {
  requested: boolean;
  configured: boolean;
  root?: string;
  guideUrl: string;
  estimatedAdditionalBytes: number;
}
