import type {
  GetProvidersSnapshotResponseMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

type Update = Extract<SessionOutboundMessage, { type: "providers_snapshot_update" }>;
type Snapshot = GetProvidersSnapshotResponseMessage["payload"];

/** Resolve announcements only while observed, coalescing changes during a fetch. */
export class ProviderSnapshotUpdates {
  private pending = new Map<string | undefined, { latest: Update | null }>();

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

  receive(update: Update): void {
    const cwd = update.payload.cwd;
    const existing = this.pending.get(cwd);
    if (existing) {
      existing.latest = update;
      return;
    }
    const pending = { latest: update as Update | null };
    this.pending.set(cwd, pending);
    void (async () => {
      try {
        while (pending.latest && this.pending.get(cwd) === pending) {
          pending.latest = null;
          const snapshot = await this.host.fetch(cwd);
          if (this.pending.get(cwd) !== pending) return;
          // A change arriving while the body was in flight needs the current body.
          // If that response already covers it, no second fetch is necessary.
          if (pending.latest) {
            const latest: Update = pending.latest;
            if (latest.payload.snapshotHash !== snapshot.snapshotHash) continue;
            pending.latest = null;
          }
          this.host.emit({ type: "providers_snapshot_update", payload: snapshot });
        }
      } catch (error) {
        if (this.pending.get(cwd) === pending) this.host.failed(error);
      } finally {
        if (this.pending.get(cwd) === pending) this.pending.delete(cwd);
      }
    })();
  }
}
