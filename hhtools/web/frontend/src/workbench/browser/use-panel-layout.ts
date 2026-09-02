import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";

type PanelSide = "sidebar" | "inspector";

export interface PanelLayoutState {
  sidebarWidth: number;
  inspectorWidth: number;
  sidebarHidden: boolean;
  inspectorHidden: boolean;
}

const STORAGE_KEY = "hhtools-desktop-panel-layout-v1";
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 520;
const INSPECTOR_MIN = 240;
const INSPECTOR_MAX = 640;
const HANDLE_WIDTH = 6;
const MIN_STAGE_WIDTH = 360;

const DEFAULT_LAYOUT: PanelLayoutState = {
  sidebarWidth: 208,
  inspectorWidth: 360,
  sidebarHidden: false,
  inspectorHidden: false,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadLayout(): PanelLayoutState {
  try {
    return {
      ...DEFAULT_LAYOUT,
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function constrain(
  layout: PanelLayoutState,
  preferred?: PanelSide,
): PanelLayoutState {
  const next = {
    ...layout,
    sidebarWidth: clamp(layout.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
    inspectorWidth: clamp(layout.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX),
  };
  const handles =
    (next.sidebarHidden ? 0 : HANDLE_WIDTH) +
    (next.inspectorHidden ? 0 : HANDLE_WIDTH);
  const available = Math.max(0, window.innerWidth - handles - MIN_STAGE_WIDTH);
  if (next.sidebarHidden && next.inspectorHidden) return next;
  if (next.sidebarHidden)
    return {
      ...next,
      inspectorWidth: Math.min(next.inspectorWidth, available),
    };
  if (next.inspectorHidden)
    return { ...next, sidebarWidth: Math.min(next.sidebarWidth, available) };
  if (next.sidebarWidth + next.inspectorWidth <= available) return next;

  if (preferred === "sidebar") {
    next.inspectorWidth = clamp(
      available - next.sidebarWidth,
      INSPECTOR_MIN,
      INSPECTOR_MAX,
    );
    next.sidebarWidth = clamp(
      available - next.inspectorWidth,
      SIDEBAR_MIN,
      SIDEBAR_MAX,
    );
    return next;
  }
  if (preferred === "inspector") {
    next.sidebarWidth = clamp(
      available - next.inspectorWidth,
      SIDEBAR_MIN,
      SIDEBAR_MAX,
    );
    next.inspectorWidth = clamp(
      available - next.sidebarWidth,
      INSPECTOR_MIN,
      INSPECTOR_MAX,
    );
    return next;
  }

  const removable =
    next.sidebarWidth - SIDEBAR_MIN + next.inspectorWidth - INSPECTOR_MIN;
  if (removable <= 0) return next;
  const overflow = next.sidebarWidth + next.inspectorWidth - available;
  const sidebarShare = (next.sidebarWidth - SIDEBAR_MIN) / removable;
  next.sidebarWidth = clamp(
    next.sidebarWidth - overflow * sidebarShare,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
  );
  next.inspectorWidth = clamp(
    available - next.sidebarWidth,
    INSPECTOR_MIN,
    INSPECTOR_MAX,
  );
  return next;
}

function persist(layout: PanelLayoutState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
}

/** Owns resizable workbench chrome, mirroring VS Code's layout-service role. */
export function usePanelLayout() {
  const [state, setState] = useState<PanelLayoutState>(() =>
    constrain(loadLayout()),
  );

  const update = useCallback(
    (change: (current: PanelLayoutState) => PanelLayoutState) => {
      setState((current) => {
        const next = constrain(change(current));
        persist(next);
        return next;
      });
    },
    [],
  );

  const setHidden = useCallback(
    (side: PanelSide, hidden: boolean) => {
      update((current) => ({
        ...current,
        [side === "sidebar" ? "sidebarHidden" : "inspectorHidden"]: hidden,
      }));
    },
    [update],
  );

  const reset = useCallback(() => update(() => DEFAULT_LAYOUT), [update]);
  const revealBoth = useCallback(
    () =>
      update((current) => ({
        ...current,
        sidebarHidden: false,
        inspectorHidden: false,
      })),
    [update],
  );

  const startResize = useCallback(
    (side: PanelSide, event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      target.classList.add("dragging");
      const startX = event.clientX;
      const startWidth =
        side === "sidebar" ? state.sidebarWidth : state.inspectorWidth;

      const move = (moveEvent: globalThis.PointerEvent): void => {
        const delta = moveEvent.clientX - startX;
        setState((current) =>
          constrain(
            {
              ...current,
              [side === "sidebar" ? "sidebarWidth" : "inspectorWidth"]:
                side === "sidebar" ? startWidth + delta : startWidth - delta,
            },
            side,
          ),
        );
      };
      const stop = (): void => {
        target.classList.remove("dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        setState((current) => {
          persist(current);
          return current;
        });
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    },
    [state.inspectorWidth, state.sidebarWidth],
  );

  useEffect(() => {
    const resize = (): void => setState((current) => constrain(current));
    window.addEventListener("resize", resize);
    window.__hhPanelLayout = { revealBoth, reset };
    return () => {
      window.removeEventListener("resize", resize);
      delete window.__hhPanelLayout;
    };
  }, [reset, revealBoth]);

  const style = useMemo(
    () =>
      ({
        "--sidebar-w": state.sidebarHidden
          ? "0px"
          : `${Math.round(state.sidebarWidth)}px`,
        "--inspector-w": state.inspectorHidden
          ? "0px"
          : `${Math.round(state.inspectorWidth)}px`,
        "--sidebar-handle-w": state.sidebarHidden ? "0px" : `${HANDLE_WIDTH}px`,
        "--inspector-handle-w": state.inspectorHidden
          ? "0px"
          : `${HANDLE_WIDTH}px`,
      }) as CSSProperties,
    [state],
  );

  return { state, style, setHidden, startResize, reset };
}
