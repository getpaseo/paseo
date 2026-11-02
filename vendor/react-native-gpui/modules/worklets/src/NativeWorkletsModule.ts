import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  installTurboModule(bundleModeEnabled: boolean): boolean;
  prepareBundleMode(): boolean;
  toggleSlowAnimationsOnUIRuntime(): boolean;
  start(): boolean;
}

export default TurboModuleRegistry.get<Spec>('WorkletsModule');
