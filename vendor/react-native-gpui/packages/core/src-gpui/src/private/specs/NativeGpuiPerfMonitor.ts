import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type PerfMetrics = {
  enabled: boolean;
  uiFps: number;
  jsFps: number;
  memoryBytes: number;
  jsHeapBytes: number;
  droppedFrames: number;
  stutters: number;
  mountedViews: number;
  lastMountMs: number;
};

export type PerfToggle = {
  enabled: boolean;
};

export interface Spec extends TurboModule {
  perfMonitorSetEnabled(enabled: boolean): Promise<PerfToggle>;
  perfMonitorGetMetrics(): Promise<PerfMetrics>;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('GpuiPerfMonitor');
