import {
  createContext,
  useContext,
  useEffect,
  type PropsWithChildren,
} from "react";

import type { IWorkbenchServices } from "@/workbench/services/common/workbench-services";

const WorkbenchServiceContext = createContext<IWorkbenchServices | null>(null);

interface WorkbenchServicesProviderProps extends PropsWithChildren {
  readonly services: IWorkbenchServices;
}

/**
 * Exposes stable service objects without placing frequently changing UI state in
 * React context. The provider owns the service graph and releases it on unmount;
 * each disposable service is responsible for cancelling its own timers and waits.
 */
export function WorkbenchServicesProvider({
  services,
  children,
}: WorkbenchServicesProviderProps) {
  useEffect(() => () => services.dispose(), [services]);

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
