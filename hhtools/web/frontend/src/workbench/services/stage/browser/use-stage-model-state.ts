import { useCallback, useSyncExternalStore } from "react";

import type {
  IStageModelService,
  StageDisplayState,
  StageState,
} from "@/workbench/services/stage/common/stage-service";

/**
 * React read adapter for the Stage model's immutable external snapshots.
 *
 * The service instance is stable for the Workbench lifetime. React owns only
 * the subscription; it neither copies Stage state nor gains the model's write
 * side, which keeps a single semantic source of truth.
 */
export function useStageModelState(
  stageModelService: IStageModelService,
): StageState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = stageModelService.onDidChangeState(onStoreChange);
      return () => subscription.dispose();
    },
    [stageModelService],
  );
  const getSnapshot = useCallback(
    () => stageModelService.state,
    [stageModelService],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe only to the stable display slice. Playback updates still fire the
 * model event, but `useSyncExternalStore` sees the same display reference and
 * skips rendering the H2R controls at animation-frame frequency.
 */
export function useStageDisplayState(
  stageModelService: IStageModelService,
): StageDisplayState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = stageModelService.onDidChangeState(onStoreChange);
      return () => subscription.dispose();
    },
    [stageModelService],
  );
  const getSnapshot = useCallback(
    () => stageModelService.state.display,
    [stageModelService],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
