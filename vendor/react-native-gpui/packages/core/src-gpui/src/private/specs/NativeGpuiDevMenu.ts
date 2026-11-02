import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  show(): void;
  reload(): void;
  setProfilingEnabled(enabled: boolean): void;
  setHotLoadingEnabled(enabled: boolean): void;
  toggleElementInspector(): void;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DevMenu');
