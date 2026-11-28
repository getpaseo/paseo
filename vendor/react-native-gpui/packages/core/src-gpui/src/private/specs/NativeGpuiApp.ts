import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  readonly launchArgs: () => Array<string>;
  readonly quit: () => Promise<void>;
  readonly exit: (code: number) => Promise<void>;
  readonly relaunch: () => Promise<void>;
  readonly beep: () => Promise<void>;
  readonly addListener: (eventName: string) => void;
  readonly removeListeners: (count: number) => void;
}

export default TurboModuleRegistry.get<Spec>('GpuiApp');
