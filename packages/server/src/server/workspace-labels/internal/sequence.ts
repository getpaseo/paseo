import { randomUUID } from "node:crypto";
import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";

export type WorkspaceLabelChange =
  | { kind: "upsert"; label: WorkspaceLabelDefinition; previousName?: string }
  | { kind: "remove"; name: string };

interface SequencedChange {
  generation: string;
  seq: number;
  change: WorkspaceLabelChange;
}

export interface WorkspaceLabelCursor {
  generation: string;
  afterSeq: number;
}

export interface WorkspaceLabelSync {
  labels: WorkspaceLabelDefinition[];
  sync: {
    mode: "snapshot" | "changes";
    generation: string;
    headSeq: number;
    removals: Array<{ name: string; seq: number }>;
  };
}

export class WorkspaceLabelSequence {
  private readonly generation = randomUUID();
  private headSeq = 0;
  private readonly journal: SequencedChange[] = [];
  private readonly subscribers = new Set<(change: SequencedChange) => void>();

  constructor(private readonly journalLimit = 256) {}

  subscribe(listener: (change: SequencedChange) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  publish(change: WorkspaceLabelChange): void {
    const entry = { generation: this.generation, seq: ++this.headSeq, change };
    this.journal.push(entry);
    if (this.journal.length > this.journalLimit) this.journal.shift();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry);
      } catch {
        // Publication follows durable persistence and cannot fail the mutation.
      }
    }
  }

  synchronize(
    catalog: readonly WorkspaceLabelDefinition[],
    cursor?: WorkspaceLabelCursor,
  ): WorkspaceLabelSync {
    const oldestSeq = this.journal[0]?.seq ?? this.headSeq + 1;
    const canCatchUp =
      cursor?.generation === this.generation &&
      cursor.afterSeq <= this.headSeq &&
      cursor.afterSeq >= oldestSeq - 1;
    if (!canCatchUp) {
      return {
        labels: catalog.map((label) => ({ ...label })),
        sync: {
          mode: "snapshot",
          generation: this.generation,
          headSeq: this.headSeq,
          removals: [],
        },
      };
    }

    const changes = this.journal.filter((entry) => entry.seq > cursor.afterSeq);
    const upserts = new Map<string, WorkspaceLabelDefinition>();
    const removals = new Map<string, { name: string; seq: number }>();
    for (const entry of changes) {
      if (entry.change.kind === "remove") {
        const key = entry.change.name.toLowerCase();
        const wasCreatedDuringCatchUp = upserts.delete(key);
        if (!wasCreatedDuringCatchUp) {
          removals.set(key, { name: entry.change.name, seq: entry.seq });
        }
        continue;
      }
      if (entry.change.previousName) {
        const previousKey = entry.change.previousName.toLowerCase();
        const wasCreatedDuringCatchUp = upserts.delete(previousKey);
        if (!wasCreatedDuringCatchUp) {
          removals.set(previousKey, {
            name: entry.change.previousName,
            seq: entry.seq,
          });
        }
      }
      removals.delete(entry.change.label.name.toLowerCase());
      upserts.set(entry.change.label.name.toLowerCase(), entry.change.label);
    }
    return {
      labels: [...upserts.values()],
      sync: {
        mode: "changes",
        generation: this.generation,
        headSeq: this.headSeq,
        removals: [...removals.values()],
      },
    };
  }
}
