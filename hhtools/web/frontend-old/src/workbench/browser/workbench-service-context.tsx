import {
  createContext,
  useContext,
  useEffect,
  type PropsWithChildren,
} from "react";

import { toDisposable, type IDisposable } from "@/base/common/disposable";
import {
  WorkbenchLifecyclePhase,
  type IWorkbenchContributionLifecycle,
} from "@/workbench/common/contribution";
import type { IWorkbenchServices } from "@/workbench/services/common/workbench-services";

const WorkbenchServiceContext = createContext<IWorkbenchServices | null>(null);

interface WorkbenchServicesProviderProps extends PropsWithChildren {
  readonly services: IWorkbenchServices;
  readonly lifecycle: IWorkbenchContributionLifecycle;
}

function scheduleEventually(callback: () => void): IDisposable {
  if (typeof window.requestIdleCallback === "function") {
    // A timeout prevents low-priority contributions from starving forever on
    // a page that remains continuously busy.
    const handle = window.requestIdleCallback(callback, { timeout: 2_000 });
    return toDisposable(() => window.cancelIdleCallback(handle));
  }
  const handle = window.setTimeout(callback, 0);
  return toDisposable(() => window.clearTimeout(handle));
}

/**
 * Exposes stable service objects without placing frequently changing UI state in
 * React context. Its first committed effect advances Restored contributions,
 * then defers non-critical work until browser idle. The lifecycle is the single
 * owner that releases contributions before their underlying service graph.
 */
export function WorkbenchServicesProvider({
  services,
  lifecycle,
  children,
}: WorkbenchServicesProviderProps) {
  useEffect(() => {
    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    const eventually = scheduleEventually(() =>
      lifecycle.advanceTo(WorkbenchLifecyclePhase.Eventually),
    );
    return () => {
      eventually.dispose();
      lifecycle.dispose();
    };
  }, [lifecycle]);

  return (
    <WorkbenchServiceContext.Provider value={services}>
      {children}
    </WorkbenchServiceContext.Provider>
  );
}

/** Obtain services assembled once by the application entry point. */
export function useWorkbenchServices(): IWorkbenchServices {
  const services = useContext(WorkbenchServiceContext);
  if (!services) {
    throw new Error(
      "WorkbenchServicesProvider must wrap every workbench contribution.",
    );
  }
  return services;
}
