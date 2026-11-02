import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  readonly getInitialURL: () => Promise<string | null>;
  readonly canOpenURL: (url: string) => Promise<boolean>;
  readonly openURL: (url: string) => Promise<void>;
  readonly openSettings: () => Promise<void>;
  readonly addListener: (eventName: string) => void;
  readonly removeListeners: (count: number) => void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('LinkingManager');
