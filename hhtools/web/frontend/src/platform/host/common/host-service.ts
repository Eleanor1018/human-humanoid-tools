import type { GvhmrOptionalComponentState } from "@/runtime/types";

export type HostKind = "web" | "desktop";

export interface IHostService {
  readonly kind: HostKind;
  readonly isDesktop: boolean;
  selectDirectory(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  getGvhmrComponent(): Promise<GvhmrOptionalComponentState | null>;
}
