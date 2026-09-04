import type { IDisposable } from "@/base/common/disposable";

/** Lifecycle surface required by the React workbench during the migration. */
export interface ILegacyRuntimeService extends IDisposable {
  /** Resolves after the compatibility modules have installed their bridges. */
  start(): Promise<void>;
}
