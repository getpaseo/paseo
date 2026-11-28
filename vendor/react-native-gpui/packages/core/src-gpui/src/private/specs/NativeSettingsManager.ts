import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type SettingsConstants = {
  settings: Object;
};

export interface Spec extends TurboModule {
  getConstants(): SettingsConstants;
  setValues(values: Object): void;
  deleteValues(keys: Array<string>): void;
}

export default TurboModuleRegistry.get<Spec>('SettingsManager');
