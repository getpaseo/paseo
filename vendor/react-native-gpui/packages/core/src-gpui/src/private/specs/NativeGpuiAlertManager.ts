import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type AlertArgs = {
  title?: string;
  message?: string;
  buttons?: Array<Object>;
  type?: string;
  defaultValue?: string;
  cancelButtonKey?: string;
  destructiveButtonKey?: string;
  preferredButtonKey?: string;
  keyboardType?: string;
  userInterfaceStyle?: string;
  cancelable?: boolean;
};

export interface Spec extends TurboModule {
  readonly alertWithArgs: (
    args: AlertArgs,
    callback: (id: number, value: string) => void,
  ) => void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('AlertManager');
