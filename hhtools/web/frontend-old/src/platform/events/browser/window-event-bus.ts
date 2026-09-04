import { toDisposable, type IDisposable } from "@/base/common/disposable";

export type HHToolsWindowEventName = Extract<
  keyof WindowEventMap,
  `hhtools:${string}`
>;
type EventDetail<K extends HHToolsWindowEventName> =
  WindowEventMap[K] extends CustomEvent<infer Detail> ? Detail : never;

/** Typed boundary around legacy CustomEvents. React components consume this
 * service instead of registering ad-hoc global listeners throughout the tree.
 */
export class WindowEventBus {
  emit<K extends HHToolsWindowEventName>(
    type: K,
    detail: EventDetail<K>,
  ): void {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on<K extends HHToolsWindowEventName>(
    type: K,
    listener: (event: WindowEventMap[K]) => void,
  ): IDisposable {
    const wrapped = listener as EventListener;
    window.addEventListener(type, wrapped);
    return toDisposable(() => window.removeEventListener(type, wrapped));
  }
}

export const windowEventBus = new WindowEventBus();
