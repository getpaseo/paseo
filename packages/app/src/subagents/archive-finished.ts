import type { Agent } from "@/stores/session-store";
import type { SubagentRow } from "./select";

export type ArchiveFinishedStatus =
  | { kind: "idle" }
  | { kind: "archiving"; completedCount: number; totalCount: number }
  | { kind: "failed"; failedCount: number; totalCount: number };

export interface ArchiveFinishedState {
  eligibleCount: number;
  status: ArchiveFinishedStatus;
}

export interface ArchiveFinishedOutcome {
  archivedPaseoIds: string[];
  dismissedProviderIds: string[];
  skippedPaseoIds: string[];
  failures: Array<{ id: string; error: unknown }>;
}

export type ManagedSubagentSnapshot = Pick<Agent, "id" | "status" | "parentAgentId" | "archivedAt">;

export interface ArchiveFinishedSubagentsDeps {
  parentAgentId: string;
  getManagedSubagent: (id: string) => ManagedSubagentSnapshot | undefined;
  archiveManagedSubagent: (id: string) => Promise<void>;
  dismissProviderSubagents: (ids: string[]) => void;
}

export interface ArchiveFinishedSubagents {
  getState(): ArchiveFinishedState;
  setRows(rows: readonly SubagentRow[]): void;
  subscribe(listener: () => void): () => void;
  archiveFinished(): Promise<ArchiveFinishedOutcome>;
}

export function isFinishedSubagent(row: SubagentRow): boolean {
  if (row.kind === "paseo") return row.status === "idle" || row.status === "error";
  return row.status === "completed" || row.status === "failed" || row.status === "canceled";
}

function canArchiveManagedSubagent(
  agent: ManagedSubagentSnapshot | undefined,
  parentAgentId: string,
): boolean {
  return Boolean(
    agent &&
    !agent.archivedAt &&
    agent.parentAgentId === parentAgentId &&
    (agent.status === "idle" || agent.status === "error"),
  );
}

function eligibleSignature(rows: readonly SubagentRow[]): string {
  return identitySignature(rowIdentities(rows));
}

function managedRowIdentity(id: string): string {
  return `paseo:${id}`;
}

function rowIdentity(row: SubagentRow): string {
  return row.kind === "paseo" ? managedRowIdentity(row.id) : `provider:${row.id}`;
}

function rowIdentities(rows: readonly SubagentRow[]): Set<string> {
  return new Set(rows.map(rowIdentity));
}

function identitySignature(ids: ReadonlySet<string>): string {
  return [...ids].sort().join("\0");
}

function emptyOutcome(): ArchiveFinishedOutcome {
  return {
    archivedPaseoIds: [],
    dismissedProviderIds: [],
    skippedPaseoIds: [],
    failures: [],
  };
}

export function createArchiveFinishedSubagents(
  initialRows: readonly SubagentRow[],
  deps: ArchiveFinishedSubagentsDeps,
): ArchiveFinishedSubagents {
  let eligibleRows = initialRows.filter(isFinishedSubagent);
  let signature = eligibleSignature(eligibleRows);
  let failedSignature: string | null = null;
  let state: ArchiveFinishedState = {
    eligibleCount: eligibleRows.length,
    status: { kind: "idle" },
  };
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) listener();
  };
  const setState = (next: ArchiveFinishedState) => {
    state = next;
    publish();
  };

  const setRows = (rows: readonly SubagentRow[]) => {
    const nextEligibleRows = rows.filter(isFinishedSubagent);
    const nextSignature = eligibleSignature(nextEligibleRows);
    const eligibilityChanged = signature !== nextSignature;
    eligibleRows = nextEligibleRows;
    signature = nextSignature;

    if (state.status.kind === "failed" && failedSignature !== signature) {
      failedSignature = null;
      setState({ eligibleCount: eligibleRows.length, status: { kind: "idle" } });
      return;
    }
    if (state.eligibleCount !== eligibleRows.length || eligibilityChanged) {
      setState({ ...state, eligibleCount: eligibleRows.length });
    }
  };

  const archiveFinished = () => {
    if (state.status.kind === "archiving" || eligibleRows.length === 0) {
      return Promise.resolve(emptyOutcome());
    }

    const snapshot = eligibleRows;
    const totalCount = snapshot.length;
    setState({
      eligibleCount: eligibleRows.length,
      status: { kind: "archiving", completedCount: 0, totalCount },
    });
    return runArchiveFinished(snapshot, deps, (completedCount) => {
      setState({
        eligibleCount: eligibleRows.length,
        status: { kind: "archiving", completedCount, totalCount },
      });
    }).then(({ outcome, retryableFailureIds }) => {
      failedSignature =
        retryableFailureIds.size > 0 ? identitySignature(retryableFailureIds) : null;
      setState({
        eligibleCount: eligibleRows.length,
        status:
          retryableFailureIds.size > 0
            ? {
                kind: "failed",
                failedCount: retryableFailureIds.size,
                totalCount: retryableFailureIds.size,
              }
            : { kind: "idle" },
      });
      return outcome;
    });
  };

  return {
    getState: () => state,
    setRows,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    archiveFinished,
  };
}

async function runArchiveFinished(
  rows: readonly SubagentRow[],
  deps: ArchiveFinishedSubagentsDeps,
  reportProgress: (completedCount: number) => void,
): Promise<{ outcome: ArchiveFinishedOutcome; retryableFailureIds: Set<string> }> {
  const providerIds = rows.filter((row) => row.kind === "provider").map((row) => row.id);
  const paseoIds = rows.filter((row) => row.kind === "paseo").map((row) => row.id);
  let completedCount = 0;
  const outcome = emptyOutcome();
  const retryableFailureIds = new Set<string>();

  if (providerIds.length > 0) {
    deps.dismissProviderSubagents(providerIds);
    outcome.dismissedProviderIds.push(...providerIds);
    completedCount += providerIds.length;
    reportProgress(completedCount);
  }

  for (const id of paseoIds) {
    if (canArchiveManagedSubagent(deps.getManagedSubagent(id), deps.parentAgentId)) {
      try {
        await deps.archiveManagedSubagent(id);
        outcome.archivedPaseoIds.push(id);
      } catch (error) {
        outcome.failures.push({ id, error });
        if (canArchiveManagedSubagent(deps.getManagedSubagent(id), deps.parentAgentId)) {
          retryableFailureIds.add(managedRowIdentity(id));
        }
      }
    } else {
      outcome.skippedPaseoIds.push(id);
    }
    completedCount += 1;
    reportProgress(completedCount);
  }

  return { outcome, retryableFailureIds };
}
