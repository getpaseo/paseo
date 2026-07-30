import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { FileVersion } from "@getpaseo/protocol/messages";

export interface LiveFileTarget {
  cwd: string;
  path: string;
}

export interface LiveFileSubscription {
  initial: FileVersion;
  unsubscribe(): void;
}

export interface LiveFileSession {
  subscribe(
    target: LiveFileTarget,
    onVersion: (version: FileVersion) => void,
  ): Promise<LiveFileSubscription>;
  read(target: LiveFileTarget): Promise<FileReadResult>;
}

export type LiveFileReadState =
  | { status: "idle" }
  | { status: "pending"; requested: boolean }
  | { status: "error"; error: string };

export interface LiveFileSnapshot {
  file: FileReadResult | null;
  version: FileVersion | null;
  read: LiveFileReadState;
}

const idleSnapshot: LiveFileSnapshot = {
  file: null,
  version: null,
  read: { status: "idle" },
};

export class LiveFileModel {
  private readonly listeners = new Set<() => void>();
  private snapshot: LiveFileSnapshot = idleSnapshot;
  private session: LiveFileSession | null = null;
  private target: LiveFileTarget | null = null;
  private liveUpdates = false;
  private unsubscribe: (() => void) | null = null;
  private subscriptionPending = false;
  private generation = 0;
  private issuedReadSequence = 0;
  private activeReadSequence: number | null = null;
  private activeReadRequested = false;
  private observedAfterReadSequence: number | null = null;
  private refreshQueued = false;
  private requestedRefreshQueued = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LiveFileSnapshot => this.snapshot;

  getVersion = (): FileVersion | null => this.snapshot.version;

  open(input: { session: LiveFileSession; target: LiveFileTarget; liveUpdates: boolean }): void {
    this.reset();
    this.session = input.session;
    this.target = input.target;
    this.liveUpdates = input.liveUpdates;
    const generation = this.generation;
    if (!input.liveUpdates) {
      this.scheduleRead(false);
      return;
    }
    void this.startSubscription(generation);
  }

  close(): void {
    this.reset();
  }

  refresh = (): void => {
    if (!this.session || !this.target) return;
    if (this.liveUpdates && !this.unsubscribe && !this.subscriptionPending) {
      void this.startSubscription(this.generation);
    }
    this.scheduleRead(true);
  };

  private scheduleRead(requested: boolean): void {
    if (this.activeReadSequence !== null) {
      this.refreshQueued = true;
      this.activeReadRequested ||= requested;
      this.requestedRefreshQueued ||= requested;
      if (requested && this.snapshot.read.status === "pending") {
        this.setSnapshot({ ...this.snapshot, read: { status: "pending", requested: true } });
      }
      return;
    }
    this.startRead(requested);
  }

  private reset(): void {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
    this.target = null;
    this.liveUpdates = false;
    this.subscriptionPending = false;
    this.issuedReadSequence = 0;
    this.activeReadSequence = null;
    this.activeReadRequested = false;
    this.observedAfterReadSequence = null;
    this.refreshQueued = false;
    this.requestedRefreshQueued = false;
    this.setSnapshot(idleSnapshot);
  }

  private async startSubscription(generation: number): Promise<void> {
    const session = this.session;
    const target = this.target;
    if (!session || !target) return;
    this.subscriptionPending = true;
    let receivedUpdate = false;
    try {
      const subscription = await session.subscribe(target, (version) => {
        if (generation !== this.generation) return;
        receivedUpdate = true;
        this.observeVersion(version);
      });
      if (generation !== this.generation) {
        subscription.unsubscribe();
        return;
      }
      this.subscriptionPending = false;
      this.unsubscribe = subscription.unsubscribe;
      if (!receivedUpdate) this.observeVersion(subscription.initial);
    } catch {
      if (generation !== this.generation) return;
      this.subscriptionPending = false;
      this.scheduleRead(false);
    }
  }

  private observeVersion(version: FileVersion): void {
    this.observedAfterReadSequence = this.issuedReadSequence;
    this.setSnapshot({ ...this.snapshot, version });
    this.scheduleRead(false);
  }

  private startRead(requested: boolean): void {
    const session = this.session;
    const target = this.target;
    if (!session || !target) return;
    const generation = this.generation;
    const sequence = ++this.issuedReadSequence;
    this.activeReadSequence = sequence;
    this.activeReadRequested = requested;
    this.refreshQueued = false;
    this.requestedRefreshQueued = false;
    this.setSnapshot({ ...this.snapshot, read: { status: "pending", requested } });
    void session.read(target).then(
      (file) => this.finishRead({ generation, sequence, target, file }),
      (error) => this.failRead({ generation, sequence, target, error }),
    );
  }

  private finishRead(input: {
    generation: number;
    sequence: number;
    target: LiveFileTarget;
    file: FileReadResult;
  }): void {
    if (!this.isActiveRead(input.generation, input.sequence)) return;
    const requested = this.activeReadRequested;
    this.activeReadSequence = null;
    this.activeReadRequested = false;
    if (this.readPredatesLatestObservation(input.sequence)) {
      this.startRead(requested || this.takeQueuedRequested());
      return;
    }
    this.observedAfterReadSequence = null;
    this.setSnapshot({
      file: input.file,
      version: readyVersion(input.target, input.file),
      read: { status: "idle" },
    });
    this.startQueuedRead();
  }

  private failRead(input: {
    generation: number;
    sequence: number;
    target: LiveFileTarget;
    error: unknown;
  }): void {
    if (!this.isActiveRead(input.generation, input.sequence)) return;
    const requested = this.activeReadRequested;
    this.activeReadSequence = null;
    this.activeReadRequested = false;
    if (this.readPredatesLatestObservation(input.sequence)) {
      this.startRead(requested || this.takeQueuedRequested());
      return;
    }
    const message = errorMessage(input.error);
    let version = this.snapshot.version;
    if (version?.status !== "missing" && version?.status !== "error") {
      version = { status: "error", cwd: input.target.cwd, path: input.target.path, error: message };
    }
    this.setSnapshot({ ...this.snapshot, version, read: { status: "error", error: message } });
    this.startQueuedRead();
  }

  private isActiveRead(generation: number, sequence: number): boolean {
    return generation === this.generation && sequence === this.activeReadSequence;
  }

  private readPredatesLatestObservation(sequence: number): boolean {
    return this.observedAfterReadSequence !== null && sequence <= this.observedAfterReadSequence;
  }

  private startQueuedRead(): void {
    if (!this.refreshQueued) return;
    this.startRead(this.takeQueuedRequested());
  }

  private takeQueuedRequested(): boolean {
    const requested = this.requestedRefreshQueued;
    this.refreshQueued = false;
    this.requestedRefreshQueued = false;
    return requested;
  }

  private setSnapshot(snapshot: LiveFileSnapshot): void {
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function readyVersion(
  target: LiveFileTarget,
  file: FileReadResult,
): Extract<FileVersion, { status: "ready" }> {
  return {
    status: "ready",
    cwd: target.cwd,
    path: target.path,
    size: file.size,
    modifiedAt: file.modifiedAt,
    revision: file.revision,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
