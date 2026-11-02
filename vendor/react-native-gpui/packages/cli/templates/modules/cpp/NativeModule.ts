import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  greet(name: string): string;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RNModule');
