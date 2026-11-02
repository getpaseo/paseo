import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  readonly getConstants: () => {};
  readonly getString: () => Promise<string>;
  readonly setString: (content: string) => void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Clipboard');
