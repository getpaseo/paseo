import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type ShareItems = {
  message?: string;
  url?: string;
  subject?: string;
  anchor?: number;
};

export type ShareResult = {
  action: string;
  activityType?: string;
};

export interface Spec extends TurboModule {
  readonly share: (items: ShareItems) => Promise<ShareResult>;
}

export default TurboModuleRegistry.get<Spec>('GpuiShare');
