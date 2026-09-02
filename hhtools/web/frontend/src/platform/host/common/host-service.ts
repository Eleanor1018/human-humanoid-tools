import type { GvhmrOptionalComponentState } from "@/runtime/types";

export type HostKind = "web" | "desktop";

/**
 * Capabilities that differ between a normal browser and Electron.
 *
 * Workbench components depend on this interface instead of the Electron
 * preload object, which keeps the renderer portable and straightforward to
 * test. Add host-specific operations here only when both implementations can
 * provide a safe, well-defined fallback.
 */
export interface IHostService {
  readonly kind: HostKind;
  readonly isDesktop: boolean;
  selectDirectory(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  getGvhmrComponent(): Promise<GvhmrOptionalComponentState | null>;
}
