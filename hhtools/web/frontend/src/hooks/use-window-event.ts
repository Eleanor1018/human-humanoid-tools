import { useEffect, useRef } from "react";

import {
  windowEventBus,
  type HHToolsWindowEventName,
} from "@/platform/events/browser/window-event-bus";

/** Subscribe once while always invoking the latest React callback. */
export function useWindowEvent<K extends HHToolsWindowEventName>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
): void {
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(() => {
    const subscription = windowEventBus.on(type, (event) =>
      listenerRef.current(event),
    );
    return () => subscription.dispose();
  }, [type]);
}
