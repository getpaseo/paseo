import { requireNativeModule, type EventSubscription } from "expo-modules-core";

export interface TunnelSocketEvent {
  tunnelId: string;
  kind: "open" | "data" | "close";
  connectionId: string;
  dataBase64?: string;
}

interface BrowserTunnelModule {
  start(tunnelId: string): Promise<number>;
  stop(tunnelId: string): Promise<void>;
  write(connectionId: string, dataBase64: string): Promise<void>;
  close(connectionId: string): Promise<void>;
  resume(connectionId: string): Promise<void>;
  addListener(
    eventName: "onTunnelSocket",
    listener: (event: TunnelSocketEvent) => void,
  ): EventSubscription;
}

export const browserTunnel = requireNativeModule<BrowserTunnelModule>("PaseoBrowserTunnel");
