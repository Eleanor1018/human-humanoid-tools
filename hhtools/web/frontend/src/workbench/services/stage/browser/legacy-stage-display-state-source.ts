import type { IDisposable } from "@/base/common/disposable";
import type { StageDisplayState } from "@/workbench/services/stage/common/stage-service";

/**
 * Complete H2R display snapshot produced by the compatibility renderer.
 *
 * `ownsStage` prevents R2R's temporary physical hiding of H2R Three.js groups
 * from being mistaken for a user visibility change. The browser adapter maps
 * that legacy boolean onto the semantic Stage renderer owner.
 */
export interface LegacyH2rStageDisplaySnapshot
  extends Omit<StageDisplayState, "owner"> {
  readonly ownsStage: boolean;
}

/**
 * Consumer-owned port around the asynchronously loaded compatibility module.
 * A subscription must receive one complete current snapshot before later
 * changes, and its disposable owns only that listener. A rejected startup must
 * not leave a listener behind. Integration must begin in the Restored phase so
 * subscribing cannot load the runtime before React commits its DOM ports.
 */
export interface ILegacyStageDisplayStateSource {
  subscribeH2rStageDisplayState(
    listener: (snapshot: LegacyH2rStageDisplaySnapshot) => void,
  ): Promise<IDisposable>;
}
