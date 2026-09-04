import { useCallback, useSyncExternalStore } from "react";

import type {
  HumanToRobotState,
  IHumanToRobotService,
} from "../common/human-to-robot-service";

/** Subscribe React to the immutable H2R application snapshot. */
export function useHumanToRobotState(
  service: IHumanToRobotService,
): HumanToRobotState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = service.onDidChangeState(onStoreChange);
      return () => subscription.dispose();
    },
    [service],
  );
  const getSnapshot = useCallback(() => service.state, [service]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
