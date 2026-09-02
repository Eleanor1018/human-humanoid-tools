import type {
  HostKind,
  IHostService,
} from "@/platform/host/common/host-service";
import type { GvhmrOptionalComponentState } from "@/platform/host/common/gvhmr-component";

/** One host adapter keeps the React renderer identical in browser and Electron.
 * Electron-only operations remain behind the preload's narrow typed API.
 */
export class BrowserHostService implements IHostService {
  readonly isDesktop = window.hhtoolsDesktop !== undefined;
  readonly kind: HostKind = this.isDesktop ? "desktop" : "web";

  async selectDirectory(): Promise<string | null> {
    if (window.hhtoolsDesktop?.selectDirectory)
      return window.hhtoolsDesktop.selectDirectory();
    return null;
  }

  async openExternal(url: string): Promise<void> {
    if (window.hhtoolsDesktop?.openExternal) {
      await window.hhtoolsDesktop.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async getGvhmrComponent(): Promise<GvhmrOptionalComponentState | null> {
    if (!window.hhtoolsDesktop) return null;
    return (await window.hhtoolsDesktop.getOptionalComponents()).gvhmr;
  }
}
