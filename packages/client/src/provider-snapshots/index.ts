import type {
  GetProvidersSnapshotResponseMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

type Update = Extract<SessionOutboundMessage, { type: "providers_snapshot_update" }>;
type Snapshot = GetProvidersSnapshotResponseMessage["payload"];

interface PendingSnapshot {
  latest: Update;
  running: boolean;
}

/** Resolve announcements only while observed, coalescing changes during a fetch. */
export class ProviderSnapshotUpdates {
  private pending = new Map<string, PendingSnapshot>();

  constructor(
    private readonly host: {
      active(update: Update): boolean;
      fetch(cwd: string | undefined): Promise<Snapshot>;
      emit(update: Update): void;
      failed(error: unknown): void;
    },
  ) {}

  clear(): void {
    this.pending.clear();
  }

  receive(update: Update): void {
    if (!this.host.active(update)) return;
    const key = JSON.stringify([update.payload.subscriptionId, update.payload.cwd]);
    const pending = this.pending.get(key) ?? { latest: update, running: false };
    pending.latest = update;
    this.pending.set(key, pending);
    if (pending.running) return;
    pending.running = true;
    void this.resolve(key, pending);
  }

  private async resolve(key: string, pending: PendingSnapshot): Promise<void> {
    try {
      while (this.pending.get(key) === pending) {
        const announced = pending.latest;
        if (!this.host.active(announced)) return;
        const snapshot = await this.host.fetch(announced.payload.cwd);
        if (!this.host.active(announced)) return;
        if (this.pending.get(key) !== pending) return;
        // A change arriving while the body was in flight needs the current body.
        // If that response already covers it, no second fetch is necessary.
        if (
          pending.latest !== announced &&
          pending.latest.payload.snapshotHash !== snapshot.snapshotHash
        )
          continue;
        this.pending.delete(key);
        this.host.emit({
          type: "providers_snapshot_update",
          payload: { ...snapshot, subscriptionId: announced.payload.subscriptionId },
        });
        return;
      }
    } catch (error) {
      if (this.pending.get(key) === pending) this.host.failed(error);
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
}
