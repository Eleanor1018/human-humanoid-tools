import type {
  GvhmrOptionalComponentState,
  GvhmrSetupResult,
  IGvhmrComponentService,
} from "@/workbench/services/gvhmr/common/gvhmr-component-service";

/** Adapts the Electron preload without exposing it to workbench views. */
export class BrowserGvhmrComponentService
  implements IGvhmrComponentService
{
  async getState(): Promise<GvhmrOptionalComponentState | null> {
    const desktop = window.hhtoolsDesktop;
    if (!desktop) return null;
    return (await desktop.getOptionalComponents()).gvhmr;
  }

  async setup(): Promise<GvhmrSetupResult | null> {
    const desktop = window.hhtoolsDesktop;
    if (!desktop) return null;
    return desktop.setupGvhmr();
  }
}
