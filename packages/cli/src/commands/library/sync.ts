import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import {
  syncLibraryToTargets,
  type LibrarySyncTarget,
  type MaterializedMcpEntry,
  type MaterializedSkillEntry,
  type McpPayload,
  type SkillPayload,
} from "@hubtool/server";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { listEntries } from "./api.js";

interface SyncRow {
  target: LibrarySyncTarget;
  mcps: number;
  skills: number;
}

const schema: OutputSchema<SyncRow> = {
  idField: "target",
  columns: [
    { header: "TARGET", field: "target", width: 14 },
    { header: "MCPs", field: "mcps", width: 6 },
    { header: "SKILLs", field: "skills", width: 6 },
  ],
};

export interface LibrarySyncOptions extends CommandOptions {
  home?: string;
  dryRun?: boolean;
}

function resolveHome(opt?: string): string {
  return opt ?? process.env.HUBCODE_HOME ?? join(homedir(), ".hubcode");
}

export async function runLibrarySyncCommand(
  options: LibrarySyncOptions,
  _command: Command,
): Promise<ListResult<SyncRow>> {
  const entries = await listEntries({});
  const mcps: MaterializedMcpEntry[] = [];
  const skills: MaterializedSkillEntry[] = [];

  for (const e of entries) {
    if (!e.activation?.active) continue;
    const targets = e.activation.syncTargets;
    if (e.kind === "mcp") {
      mcps.push({
        id: e.id,
        name: e.name,
        payload: e.payload as McpPayload,
        syncTargets: targets,
      });
    } else if (e.kind === "skill") {
      skills.push({
        id: e.id,
        name: e.name,
        displayName: e.displayName,
        description: e.description ?? undefined,
        payload: e.payload as SkillPayload,
        syncTargets: targets,
      });
    }
  }

  if (options.dryRun) {
    const buckets: Record<string, { mcp: number; skill: number }> = {};
    const bump = (t: string, key: "mcp" | "skill") => {
      if (!buckets[t]) buckets[t] = { mcp: 0, skill: 0 };
      buckets[t][key]++;
    };
    for (const m of mcps) for (const t of m.syncTargets) bump(t, "mcp");
    for (const s of skills) for (const t of s.syncTargets) bump(t, "skill");
    return {
      type: "list",
      data: Object.keys(buckets).map((t) => ({
        target: t as LibrarySyncTarget,
        mcps: buckets[t]!.mcp,
        skills: buckets[t]!.skill,
      })),
      schema,
    };
  }

  const report = await syncLibraryToTargets({
    hubcodeHome: resolveHome(options.home),
    mcps,
    skills,
  });

  return {
    type: "list",
    data: (Object.keys(report.counts) as LibrarySyncTarget[]).map((t) => ({
      target: t,
      mcps: report.counts[t].mcp,
      skills: report.counts[t].skill,
    })),
    schema,
  };
}
