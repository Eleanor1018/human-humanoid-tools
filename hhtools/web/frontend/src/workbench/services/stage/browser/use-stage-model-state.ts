import { useCallback, useSyncExternalStore } from "react";

import type {
  IStageModelService,
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
