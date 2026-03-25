import path from "node:path";
import { promises as fs } from "node:fs";

import { count } from "drizzle-orm";
import type { Logger } from "pino";

import { parseStoredAgentRecord, type StoredAgentRecord } from "../agent/agent-storage.js";
import { normalizeWorkspaceId } from "../workspace-registry-model.js";
import type { PaseoDatabaseHandle } from "./pglite-database.js";
import { toAgentSnapshotRowValues } from "./db-agent-snapshot-store.js";
import { agentSnapshots, workspaces } from "./schema.js";

export type LegacyAgentSnapshotImportResult =
  | {
      status: "imported";
      importedAgents: number;
    }
  | {
      status: "skipped";
      reason: "database-not-empty" | "no-legacy-files";
    };

export async function importLegacyAgentSnapshots(options: {
  db: PaseoDatabaseHandle["db"];
  paseoHome: string;
  logger: Logger;
}): Promise<LegacyAgentSnapshotImportResult> {
  if (await hasAnyAgentSnapshotRows(options.db)) {
    options.logger.info("Skipping legacy agent snapshot import because the DB is not empty");
    return {
      status: "skipped",
      reason: "database-not-empty",
    };
  }

  const records = await readLegacyAgentRecords(path.join(options.paseoHome, "agents"), options.logger);
  if (records.length === 0) {
    options.logger.info("Skipping legacy agent snapshot import because no legacy files exist");
    return {
      status: "skipped",
      reason: "no-legacy-files",
    };
  }

  await options.db.transaction(async (tx) => {
    const workspaceRows = await tx.select({ workspaceId: workspaces.workspaceId }).from(workspaces);
    const workspaceIds = new Set(workspaceRows.map((row) => row.workspaceId));
    const rows = records.map((record) => {
      const workspaceId = normalizeWorkspaceId(record.cwd);
      return toAgentSnapshotRowValues({
        record,
        workspaceId: workspaceIds.has(workspaceId) ? workspaceId : null,
      });
    });
    await tx.insert(agentSnapshots).values(rows);
  });

  options.logger.info(
    { importedAgents: records.length },
    "Imported legacy agent snapshots into the database",
  );

  return {
    status: "imported",
    importedAgents: records.length,
  };
}

async function readLegacyAgentRecords(baseDir: string, logger: Logger): Promise<StoredAgentRecord[]> {
  let entries: Array<import("node:fs").Dirent> = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const recordsById = new Map<string, StoredAgentRecord>();
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const record = await readRecordFile(path.join(baseDir, entry.name), logger);
      if (record) {
        recordsById.set(record.id, record);
      }
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    let childEntries: Array<import("node:fs").Dirent> = [];
    try {
      childEntries = await fs.readdir(path.join(baseDir, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const childEntry of childEntries) {
      if (!childEntry.isFile() || !childEntry.name.endsWith(".json")) {
        continue;
      }
      const record = await readRecordFile(path.join(baseDir, entry.name, childEntry.name), logger);
      if (record) {
        recordsById.set(record.id, record);
      }
    }
  }

  return Array.from(recordsById.values());
}

async function readRecordFile(filePath: string, logger: Logger): Promise<StoredAgentRecord | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseStoredAgentRecord(JSON.parse(raw));
  } catch (error) {
    logger.error({ err: error, filePath }, "Skipping invalid legacy agent snapshot");
    return null;
  }
}

async function hasAnyAgentSnapshotRows(db: PaseoDatabaseHandle["db"]): Promise<boolean> {
  const rows = await db.select({ count: count() }).from(agentSnapshots);
  return (rows[0]?.count ?? 0) > 0;
}
