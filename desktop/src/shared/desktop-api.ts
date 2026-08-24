import type { RuntimeState } from './runtime-state'

export const DESKTOP_CHANNELS = {
  getRuntimeState: 'hhtools:get-runtime-state',
  restartBackend: 'hhtools:restart-backend',
  openExternal: 'hhtools:open-external',
  runtimeStateChanged: 'hhtools:runtime-state-changed'
} as const

export interface HHToolsDesktopApi {
  getRuntimeState(): Promise<RuntimeState>
  restartBackend(): Promise<RuntimeState>
  openExternal(url: string): Promise<void>
  onRuntimeStateChanged(listener: (state: RuntimeState) => void): () => void
}

declare global {
  interface Window {
    hhtoolsDesktop: HHToolsDesktopApi
  }
}
