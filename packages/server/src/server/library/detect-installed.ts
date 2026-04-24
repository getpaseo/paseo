import { promises as fs } from "node:fs";
import path from "node:path";
import { AGENT_INTEGRATIONS, type AgentIntegration } from "./agent-integrations.js";

/**
 * Return the subset of `AGENT_INTEGRATIONS` whose `bin` is resolvable on the
 * current PATH. Used by the UI to hide agents the user hasn't installed.
 *
 * Implementation is a manual PATH scan rather than shelling out to `which`
 * — avoids spawning per agent and stays fast on Windows (`.cmd`/`.exe`
 * fallbacks). Result is cached in-process for the provided TTL because the
 * renderer asks once per `Add …` modal open.
 */
const CACHE_TTL_MS = 10_000;
let cache: { at: number; ids: string[] } | null = null;

export async function detectInstalledAgents(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.ids;

  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
      : [""];

  const results = await Promise.all(
    AGENT_INTEGRATIONS.map(async (agent) => {
      const found = await binOnPath(agent.bin, dirs, exts);
      return found ? agent.id : null;
    }),
  );
  // hubcode-gui is always "installed" — it's the daemon itself, no binary
  // to probe. Library entries targeting this id are injected directly into
  // the SDK sessions via GuiMcpRegistry.
  const ids = ["hubcode-gui", ...results.filter((id): id is string => id !== null)];
  cache = { at: Date.now(), ids };
  return ids;
}

export function clearInstalledAgentsCache(): void {
  cache = null;
}

async function binOnPath(bin: string, dirs: string[], exts: string[]): Promise<boolean> {
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return true;
      } catch {
        /* not there; try next */
      }
    }
  }
  return false;
}

export function agentMetaForClient(): Array<{
  id: string;
  label: string;
  bin: string;
  installHint?: string;
  supportsMcp: boolean;
  supportsSkills: boolean;
}> {
  // Virtual "hubcode-gui" target — lets library entries be injected directly
  // into Hubcode's in-process agent sessions without touching any CLI config
  // file. Sync writers skip this id; the daemon's GuiMcpRegistry handles it.
  const virtual = {
    id: "hubcode-gui",
    label: "Hubcode GUI",
    bin: "hubcode",
    supportsMcp: true,
    supportsSkills: false,
  };
  return [
    virtual,
    ...AGENT_INTEGRATIONS.map((a: AgentIntegration) => ({
      id: a.id,
      label: a.label,
      bin: a.bin,
      installHint: a.installHint,
      supportsMcp: !!a.mcp,
      supportsSkills: !!a.skills,
    })),
  ];
}
