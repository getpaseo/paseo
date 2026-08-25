import type { InAppNotificationItem, InAppNotificationData } from "./types";

type Listener = () => void;

class InAppNotificationStore {
  private notifications: InAppNotificationItem[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;

  public getNotifications(): InAppNotificationItem[] {
    return this.notifications;
  }

  public push(item: {
    title: string;
    body?: string;
    data?: InAppNotificationData;
    durationMs?: number | null;
  }): string {
    const id = `in-app-notif-${this.nextId++}-${Date.now()}`;
    const entry: InAppNotificationItem = {
      id,
      title: item.title,
      body: item.body,
      data: item.data,
      durationMs: item.durationMs === undefined ? 5000 : item.durationMs,
      createdAt: Date.now(),
    };

    // Keep only the 3 most recent notifications
    this.notifications = [entry, ...this.notifications.slice(0, 2)];
    this.notify();
    return id;
  }

  public dismiss(id: string): void {
    const prevLen = this.notifications.length;
    this.notifications = this.notifications.filter((n) => n.id !== id);
    if (this.notifications.length !== prevLen) {
      this.notify();
    }
  }

  public clear(): void {
    this.notifications = [];
    this.notify();
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const inAppNotificationStore = new InAppNotificationStore();
