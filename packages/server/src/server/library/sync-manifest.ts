import path from "node:path";
import { readJsonIfExists, writeFileAtomic } from "./atomic-write.js";
import { AGENT_INTEGRATIONS } from "./agent-integrations.js";

/**
 * Per-target list of keys (server names / skill folder names) that Hubcode
 * wrote on the last sync. Used to diff and remove entries the user unchecked,
 * without touching keys the user added manually.
 *
 * Keys are open-ended (any integration id) so adding new agents doesn't
 * require a schema bump — the manifest just grows.
 */
export interface SyncManifest {
  version: 1;
  lastSyncAt: string;
  targets: Record<string, { mcpKeys: string[]; skillKeys: string[] }>;
}

function emptyManifest(): SyncManifest {
  const targets: Record<string, { mcpKeys: string[]; skillKeys: string[] }> = {};
  for (const a of AGENT_INTEGRATIONS) {
    targets[a.id] = { mcpKeys: [], skillKeys: [] };
  }
  return {
    version: 1,
    lastSyncAt: new Date(0).toISOString(),
    targets,
  };
}

export function manifestPath(hubcodeHome: string): string {
  return path.join(hubcodeHome, "library-sync-manifest.json");
}

export async function loadManifest(hubcodeHome: string): Promise<SyncManifest> {
  const data = await readJsonIfExists<SyncManifest>(manifestPath(hubcodeHome));
  if (!data || data.version !== 1) return emptyManifest();
  // Backfill any new integrations added since the last sync so the caller
  // can index into `manifest.targets[id]` safely.
  for (const a of AGENT_INTEGRATIONS) {
    if (!data.targets[a.id]) {
      data.targets[a.id] = { mcpKeys: [], skillKeys: [] };
    }
  }
  return data;
}

export async function saveManifest(hubcodeHome: string, manifest: SyncManifest): Promise<void> {
  await writeFileAtomic(manifestPath(hubcodeHome), JSON.stringify(manifest, null, 2));
}
