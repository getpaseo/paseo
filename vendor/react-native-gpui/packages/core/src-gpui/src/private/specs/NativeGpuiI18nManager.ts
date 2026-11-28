import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type I18nManagerConstants = {
  isRTL: boolean;
  doLeftAndRightSwapInRTL: boolean;
  localeIdentifier: string;
};

export interface Spec extends TurboModule {
  getConstants(): I18nManagerConstants;
  allowRTL(allowRTL: boolean): void;
  forceRTL(forceRTL: boolean): void;
  swapLeftAndRightInRTL(swapLeftAndRight: boolean): void;
}

export default TurboModuleRegistry.get<Spec>('I18nManager');
