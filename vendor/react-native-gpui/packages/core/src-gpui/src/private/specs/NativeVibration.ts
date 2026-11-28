import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  readonly vibrate: (pattern: number) => void;
  readonly cancel: () => void;
}

export default TurboModuleRegistry.get<Spec>('Vibration');
