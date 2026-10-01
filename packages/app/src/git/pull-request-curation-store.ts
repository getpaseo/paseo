import { useMemo, useSyncExternalStore } from "react";
import {
  normalizePullRequestCuration,
  type PullRequestCuration,
} from "@/git/pull-request-curation";
import type { RelatedPullRequest } from "@/git/related-pull-requests";

interface WorkspaceCurationRecord {
  curation: PullRequestCuration;
  facts: Map<number, RelatedPullRequest>;
}

class EphemeralPullRequestCurationStore {
  private records = new Map<string, WorkspaceCurationRecord>();
  private versions = new Map<string, number>();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion(workspaceKey: string): number {
    return this.versions.get(workspaceKey) ?? 0;
  }

  private touch(workspaceKey: string): void {
    this.versions.set(workspaceKey, this.getVersion(workspaceKey) + 1);
    for (const listener of this.listeners) {
      listener();
    }
  }

  private recordFor(workspaceKey: string): WorkspaceCurationRecord {
    const existing = this.records.get(workspaceKey);
    if (existing) {
      return existing;
    }
    const record: WorkspaceCurationRecord = {
      curation: { added: [], removed: [] },
      facts: new Map(),
    };
    this.records.set(workspaceKey, record);
    return record;
  }

  getCuration(workspaceKey: string): PullRequestCuration {
    return this.records.get(workspaceKey)?.curation ?? { added: [], removed: [] };
  }

  getFacts(workspaceKey: string): RelatedPullRequest[] {
    return [...(this.records.get(workspaceKey)?.facts.values() ?? [])];
  }

  attach(workspaceKey: string, facts: RelatedPullRequest): void {
    const record = this.recordFor(workspaceKey);
    record.facts.set(facts.number, facts);
    record.curation = normalizePullRequestCuration({
      added: [...record.curation.added, facts.number],
      removed: record.curation.removed.filter((number) => number !== facts.number),
    });
    this.touch(workspaceKey);
  }

  remove(workspaceKey: string, number: number): void {
    const record = this.recordFor(workspaceKey);
    record.facts.delete(number);
    record.curation = normalizePullRequestCuration({
      added: record.curation.added.filter((candidate) => candidate !== number),
      removed: [...record.curation.removed, number],
    });
    this.touch(workspaceKey);
  }

  hydrate(workspaceKey: string, curation: PullRequestCuration | null | undefined): void {
    const next = normalizePullRequestCuration(curation);
    const current = this.getCuration(workspaceKey);
    if (
      current.added.join(",") === next.added.join(",") &&
      current.removed.join(",") === next.removed.join(",")
    ) {
      return;
    }
    this.recordFor(workspaceKey).curation = next;
    this.touch(workspaceKey);
  }

  clear(workspaceKey: string): void {
    if (this.records.delete(workspaceKey)) {
      this.touch(workspaceKey);
    }
  }
}

export const pullRequestCurationStore = new EphemeralPullRequestCurationStore();

export function usePullRequestCuration(workspaceKey: string): {
  curation: PullRequestCuration;
  facts: RelatedPullRequest[];
} {
  const version = useSyncExternalStore(
    pullRequestCurationStore.subscribe,
    () => pullRequestCurationStore.getVersion(workspaceKey),
    () => pullRequestCurationStore.getVersion(workspaceKey),
  );
  return useMemo(() => {
    void version;
    return {
      curation: pullRequestCurationStore.getCuration(workspaceKey),
      facts: pullRequestCurationStore.getFacts(workspaceKey),
    };
  }, [workspaceKey, version]);
}
