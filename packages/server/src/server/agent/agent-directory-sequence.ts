import { randomUUID } from "node:crypto";

export interface AgentDirectoryChange {
  seq: number;
  type: "upsert" | "delete";
  agentId: string;
}

const MAX_TRACKED_CHANGES = 5000;

/**
 * Tracks agent record mutations so clients can resync the agent directory
 * incrementally instead of re-fetching the full paginated snapshot on every
 * reconnect.
 *
 * Every persisted agent upsert/delete records a change with a monotonically
 * increasing `seq`. A client that remembers the last `seq` it applied can ask
 * for `changesAfter(seq)` and receive only the mutations it missed. Deletions
 * are reported explicitly so the client can drop agents that no longer exist.
 *
 * The sequence is in-memory and process-local: a daemon restart resets it to
 * zero with a fresh `generation`. Clients pin the generation they synced under
 * and fall back to a full resync when it changes.
 *
 * Only recent changes are retained (`MAX_TRACKED_CHANGES`); a client whose
 * cursor has aged past the retained window is told the delta is unavailable
 * and must full-resync.
 */
export class AgentDirectorySequenceTracker {
  private seq = 0;
  private readonly generation: string;
  private readonly changes: AgentDirectoryChange[] = [];
  private minTrackedSeq = 1;

  constructor(generation?: string) {
    this.generation = generation ?? randomUUID();
  }

  getGeneration(): string {
    return this.generation;
  }

  getCurrentSequence(): number {
    return this.seq;
  }

  recordChange(agentId: string, type: "upsert" | "delete"): void {
    this.seq += 1;
    this.changes.push({ seq: this.seq, type, agentId });
    if (this.changes.length > MAX_TRACKED_CHANGES) {
      this.changes.shift();
    }
    this.minTrackedSeq = this.changes[0]?.seq ?? this.seq + 1;
  }

  /**
   * Returns the mutations after `afterSequence`, or `{ incremental: false }`
   * when the delta cannot be reconstructed (no changes recorded yet, cursor
   * already current, or cursor too old for the retained window). The caller
   * must also verify the client's `directoryGeneration` matches before trusting
   * a delta.
   */
  changesAfter(afterSequence: number): { changes: AgentDirectoryChange[]; incremental: boolean } {
    if (this.seq === 0) {
      return { changes: [], incremental: false };
    }
    if (afterSequence >= this.seq) {
      return { changes: [], incremental: true };
    }
    // The window starts at `minTrackedSeq`; a cursor that needs anything before
    // it can't be reconstructed, so the caller must full-resync.
    if (afterSequence + 1 < this.minTrackedSeq) {
      return { changes: [], incremental: false };
    }
    return {
      changes: this.changes.filter((change) => change.seq > afterSequence),
      incremental: true,
    };
  }
}
