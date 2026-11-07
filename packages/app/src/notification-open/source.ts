export interface NotificationTap {
  id: string;
  data: Record<string, unknown> | undefined;
}

export interface NotificationOpenSource {
  subscribe(onTap: (tap: NotificationTap) => void): () => void;
  takeLaunchTap(): Promise<NotificationTap | null>;
  acknowledge(tap: NotificationTap): void;
}

export { createNotificationOpenSource } from "./source.native";
