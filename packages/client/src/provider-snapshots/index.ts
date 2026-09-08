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
  private pending = new Map<string | undefined, PendingSnapshot>();
  private paused = false;

  constructor(
    private readonly host: {
      fetch(cwd: string | undefined): Promise<Snapshot>;
      emit(update: Update): void;
      failed(error: unknown): void;
    },
  ) {}

  clear(): void {
    this.pending.clear();
  }

  pause(): void {
    this.paused = true;
    // Invalidate old responses while retaining the announcements they would resolve.
    for (const [cwd, pending] of this.pending) {
      this.pending.set(cwd, { latest: pending.latest, running: false });
    }
  }

  resume(): void {
    this.paused = false;
    for (const pending of this.pending.values()) this.receive(pending.latest);
  }

  receive(update: Update): void {
    const cwd = update.payload.cwd;
    const pending = this.pending.get(cwd) ?? { latest: update, running: false };
    pending.latest = update;
    this.pending.set(cwd, pending);
    if (this.paused || pending.running) return;
    pending.running = true;
    void this.resolve(cwd, pending);
  }

  private async resolve(cwd: string | undefined, pending: PendingSnapshot): Promise<void> {
    try {
      while (this.pending.get(cwd) === pending) {
        const announced = pending.latest;
        const snapshot = await this.host.fetch(cwd);
        if (this.pending.get(cwd) !== pending) return;
        // A change arriving while the body was in flight needs the current body.
        // If that response already covers it, no second fetch is necessary.
        if (
          pending.latest !== announced &&
          pending.latest.payload.snapshotHash !== snapshot.snapshotHash
        )
          continue;
        this.pending.delete(cwd);
        this.host.emit({ type: "providers_snapshot_update", payload: snapshot });
        return;
      }
    } catch (error) {
      if (this.pending.get(cwd) === pending) this.host.failed(error);
    } finally {
      if (this.pending.get(cwd) === pending) this.pending.delete(cwd);
    }
  }
}
