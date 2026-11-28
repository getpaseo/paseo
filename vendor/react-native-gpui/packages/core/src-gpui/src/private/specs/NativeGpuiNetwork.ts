import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type NetworkSettings = {
  mode: string;
  rules: string;
  bypass: string;
  dnsOverHttps: string;
};

export interface Spec extends TurboModule {
  setProxy(mode: string, rules: string, bypass: string): Promise<void>;
  setDnsOverHttps(url: string): Promise<void>;
  getSettings(): Promise<NetworkSettings>;
  proxyForUrl(url: string): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('GpuiNetwork');
