import { useCallback, useMemo, useSyncExternalStore } from "react";

import type {
  IStageModelService,
  StageDisplayState,
  StageState,
} from "@/workbench/services/stage/common/stage-service";

export type StageSurfaceState = Readonly<
  Pick<StageDisplayState, "owner" | "empty" | "canResetView">
>;

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

/** Subscribe only to whether the active renderer currently supports Reset. */
export function useStageCanResetView(
  stageModelService: IStageModelService,
): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = stageModelService.onDidChangeState(onStoreChange);
      return () => subscription.dispose();
    },
    [stageModelService],
  );
  const getSnapshot = useCallback(
    () => stageModelService.state.display.canResetView,
    [stageModelService],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Observe only presentation shared by the active Stage surface.
 *
 * The Stage model replaces its display object when any H2R layer changes. The
 * cached projection below keeps the same object identity unless one of these
 * three surface fields changes, so playback and layer traffic cannot rerender
 * the parent ThreeStage tree at animation-frame frequency.
 */
export function useStageSurfaceState(
  stageModelService: IStageModelService,
): StageSurfaceState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = stageModelService.onDidChangeState(onStoreChange);
      return () => subscription.dispose();
    },
    [stageModelService],
  );
  const getSnapshot = useMemo(() => {
    let cached: StageSurfaceState | undefined;
    return (): StageSurfaceState => {
      const { owner, empty, canResetView } = stageModelService.state.display;
      if (
        cached?.owner === owner &&
        cached.empty === empty &&
        cached.canResetView === canResetView
      ) {
        return cached;
      }
      cached = Object.freeze({ owner, empty, canResetView });
      return cached;
    };
  }, [stageModelService]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
