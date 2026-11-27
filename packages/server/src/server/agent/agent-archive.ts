import type { StoredAgentRecord } from "./agent-storage.js";

export type ArchivedStoredAgentRecord = StoredAgentRecord & { archivedAt: string };

interface BuildArchivedAgentRecordOptions {
  archivedAt: string;
  /** When this archive happened. Re-archiving keeps the original archivedAt but still records it. */
  updatedAt: string;
}

export function buildArchivedAgentRecord(
  record: StoredAgentRecord,
  options: BuildArchivedAgentRecordOptions,
): ArchivedStoredAgentRecord {
  return {
    ...record,
    archivedAt: options.archivedAt,
    updatedAt: latestTimestamp(record.updatedAt, options.updatedAt),
    lastStatus: normalizeArchivedStatus(record.lastStatus),
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  };
}

// Archiving is the agent's latest change. An earlier archive time (an original archive put back
// after a failed unarchive) keeps the newer updatedAt, since clients drop an agent update that is
// older than the one they hold.
function latestTimestamp(current: string, archiveTime: string): string {
  return Date.parse(archiveTime) > Date.parse(current) ? archiveTime : current;
}

function normalizeArchivedStatus(
  status: StoredAgentRecord["lastStatus"],
): StoredAgentRecord["lastStatus"] {
  return status === "running" || status === "initializing" ? "idle" : status;
}
