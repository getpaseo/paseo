import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_INTEGRATIONS,
  mcpConfigPathFor,
  type AgentIntegration,
} from "../library/agent-integrations.js";
import { writeFileAtomic, readJsonIfExists } from "../library/atomic-write.js";
import { mergeCodexConfig } from "../library/codex-toml-merge.js";

/**
 * Writes / removes a single MCP entry pointing to the Hubcode daemon's
 * agent MCP endpoint into each detected CLI agent's MCP config. Entry key
 * is fixed (`HUBCODE_INDEXING_KEY`) so re-runs are idempotent.
 *
 * Agents whose MCP transport doesn't support HTTP (currently `codex`, which
 * is stdio-only via TOML) are intentionally skipped — the entry is
 * meaningless for them. A future PR may add stdio bridging via a small
 * launcher script.
 *
 * Failure to write one agent does not abort the others; the per-agent
 * outcome is returned for the UI to surface.
 */

export const HUBCODE_INDEXING_KEY = "hubcode-indexing";

export interface WriteHubcodeMcpInput {
  hubcodeMcpUrl: string;
  /** Restrict to a subset of detected agent ids; default = all detected. */
  agentIds?: string[];
  /** Override the home dir; for tests. */
  home?: string;
}

export interface AgentConfigOutcome {
  agentId: string;
  configPath: string | null;
  status: "written" | "removed" | "skipped" | "error" | "unsupported";
  reason?: string;
}

export async function writeHubcodeMcpEntries(
  input: WriteHubcodeMcpInput,
): Promise<AgentConfigOutcome[]> {
  const home = input.home ?? os.homedir();
  const agents = filterAgents(input.agentIds);
  const results: AgentConfigOutcome[] = [];
  for (const agent of agents) {
    results.push(await writeOneAgent(agent, input.hubcodeMcpUrl, home));
  }
  return results;
}

export async function removeHubcodeMcpEntries(
  input: { agentIds?: string[]; home?: string } = {},
): Promise<AgentConfigOutcome[]> {
  const home = input.home ?? os.homedir();
  const agents = filterAgents(input.agentIds);
  const results: AgentConfigOutcome[] = [];
  for (const agent of agents) {
    results.push(await removeOneAgent(agent, home));
  }
  return results;
}

function filterAgents(agentIds?: string[]): AgentIntegration[] {
  // `undefined` = "every MCP-capable agent"; `[]` = "none".
  if (agentIds === undefined) return AGENT_INTEGRATIONS.filter((a) => a.mcp);
  const set = new Set(agentIds);
  return AGENT_INTEGRATIONS.filter((a) => set.has(a.id) && !!a.mcp);
}

async function writeOneAgent(
  agent: AgentIntegration,
  hubcodeMcpUrl: string,
  home: string,
): Promise<AgentConfigOutcome> {
  const configPath = mcpConfigPathFor(agent, home);
  if (!configPath || !agent.mcp) {
    return { agentId: agent.id, configPath: null, status: "unsupported" };
  }
  if (!agent.mcp.supportsHttp) {
    return {
      agentId: agent.id,
      configPath,
      status: "unsupported",
      reason: "Agent MCP transport does not support HTTP; Hubcode entry skipped.",
    };
  }
  try {
    await ensureDir(path.dirname(configPath));
    if (agent.mcp.format === "toml") {
      // Reserved for stdio-only adapters; we already returned `unsupported`
      // for codex above. Defensive — don't crash if a new TOML+http adapter
      // is added later.
      return {
        agentId: agent.id,
        configPath,
        status: "unsupported",
        reason: "TOML+HTTP not implemented in PR3d",
      };
    }
    await mergeJsonHttpEntry(configPath, agent, hubcodeMcpUrl);
    return { agentId: agent.id, configPath, status: "written" };
  } catch (err) {
    return {
      agentId: agent.id,
      configPath,
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function removeOneAgent(agent: AgentIntegration, home: string): Promise<AgentConfigOutcome> {
  const configPath = mcpConfigPathFor(agent, home);
  if (!configPath || !agent.mcp) {
    return { agentId: agent.id, configPath: null, status: "unsupported" };
  }
  try {
    if (agent.mcp.format === "toml") {
      const removed = await removeFromCodexToml(configPath);
      return { agentId: agent.id, configPath, status: removed ? "removed" : "skipped" };
    }
    const removed = await removeJsonEntry(configPath, agent);
    return { agentId: agent.id, configPath, status: removed ? "removed" : "skipped" };
  } catch (err) {
    return {
      agentId: agent.id,
      configPath,
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function mergeJsonHttpEntry(
  configPath: string,
  agent: AgentIntegration,
  hubcodeMcpUrl: string,
): Promise<void> {
  const serversKey = agent.mcp!.serversPath[0]!;
  const existing = (await readJsonIfExists<Record<string, unknown>>(configPath)) ?? {};
  const existingServers = (existing[serversKey] as Record<string, unknown> | undefined) ?? {};
  const entry = httpEntryFor(agent.id, hubcodeMcpUrl);
  const next: Record<string, unknown> = {
    ...existing,
    [serversKey]: { ...existingServers, [HUBCODE_INDEXING_KEY]: entry },
  };
  await writeFileAtomic(configPath, JSON.stringify(next, null, 2), { mode: 0o600 });
}

async function removeJsonEntry(configPath: string, agent: AgentIntegration): Promise<boolean> {
  const existing = await readJsonIfExists<Record<string, unknown>>(configPath);
  if (!existing) return false;
  const serversKey = agent.mcp!.serversPath[0]!;
  const servers = existing[serversKey] as Record<string, unknown> | undefined;
  if (!servers || !(HUBCODE_INDEXING_KEY in servers)) return false;
  const { [HUBCODE_INDEXING_KEY]: _drop, ...rest } = servers;
  const next: Record<string, unknown> = { ...existing, [serversKey]: rest };
  await writeFileAtomic(configPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  return true;
}

async function removeFromCodexToml(configPath: string): Promise<boolean> {
  const exists = await fs
    .stat(configPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) return false;
  const current = await fs.readFile(configPath, "utf8");
  const merged = mergeCodexConfig({
    previousSource: current,
    nextEntries: [],
    previousOwnedKeys: [HUBCODE_INDEXING_KEY],
  });
  if (merged === current) return false;
  await writeFileAtomic(configPath, merged, { mode: 0o600 });
  return true;
}

/**
 * Per-agent shape for the HTTP entry. Most agents use `{type, url}`; cursor
 * inverts to `{url}` only; gemini and copilot use the same `{url, type:"http"}`
 * pattern as Claude.
 */
function httpEntryFor(agentId: string, url: string): Record<string, unknown> {
  switch (agentId) {
    case "cursor":
      return { url };
    case "claude-code":
    case "amp":
    case "droid":
    case "opencode":
    case "gemini":
    case "qwen":
    case "copilot":
    default:
      return { type: "http", url };
  }
}
