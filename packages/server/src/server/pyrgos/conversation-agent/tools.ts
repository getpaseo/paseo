import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { buildContext, TICKETS_CACHE_REL, TOTAL_CHARS, readTextFile } from "./context.js";
import { redact } from "./redact.js";

export const TOOL_SERVER_NAME = "harness";
export const READ_CHARS = 6000;
const SEARCH_HITS = 20;
const SEARCH_FILE_BYTES = 400_000;
const SEARCH_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonl",
  ".ts",
  ".tsx",
  ".mjs",
  ".py",
  ".sh",
  ".yml",
  ".yaml",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist", "build", ".next"]);
// Files that hold secrets by convention. Never read, whatever the caller asks.
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx|gpg|asc)|id_[a-z0-9]+|(secrets?|credentials?)(\.[^/]+)?|\.(npmrc|netrc|pypirc|pgpass|git-credentials|htpasswd|dockercfg)|_netrc|\.docker\/config\.json|\.aws\/.*|\.git\/.*|\.kube\/config|\.config\/gh\/hosts\.yml|\.ssh\/.*|\.gnupg\/.*)$/i;

export interface ToolDef {
  name: string;
  description: string;
  /** zod raw shape for the tool input. */
  shape: z.ZodRawShape;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface PaseoAgentSummary {
  id: string;
  title?: string;
  status: string;
  provider?: string;
  cwd?: string;
}

/** Read-only view of the running Paseo agents. The daemon supplies the real one. */
export interface PaseoAgentsPort {
  list(): Promise<PaseoAgentSummary[]>;
  /** Recent timeline as plain text lines, oldest first. */
  timeline(agentId: string, limit: number): Promise<string[]>;
}

export interface HarnessToolsOptions {
  harnessRoot?: string;
  workshopRoot?: string;
  agents?: PaseoAgentsPort;
}

function cap(text: string, limit = READ_CHARS): string {
  const clean = redact(text);
  return clean.length > limit ? `${clean.slice(0, limit)}\n[truncated]` : clean;
}

/** First bytes of a file, enough for `chars` characters (UTF-8 is at most 4 bytes each) plus one. */
async function readHead(file: string, chars: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(chars * 4 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function resolveInside(roots: string[], requested: string): Promise<string | null> {
  for (const root of roots) {
    const candidate = path.resolve(root, requested);
    // The name the caller asked for counts too: a harmless-looking link must not reach a secret.
    if (SECRET_FILE.test(candidate.split(path.sep).join("/"))) return null;
    let real: string;
    let realRoot: string;
    try {
      real = await realpath(candidate);
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    const rel = path.relative(realRoot, real);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    if (SECRET_FILE.test(real.split(path.sep).join("/"))) return null;
    return real;
  }
  return null;
}

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full, depth + 1);
    } else if (SEARCH_EXTENSIONS.has(path.extname(entry.name)) && !SECRET_FILE.test(full)) {
      yield full;
    }
  }
}

/** Read-only tools: harness state and files, plus running Paseo agents. Nothing here writes. */
export function createHarnessTools(options: HarnessToolsOptions): ToolDef[] {
  const roots = [options.harnessRoot, options.workshopRoot].filter((r): r is string => !!r);
  const tools: ToolDef[] = [];

  if (options.harnessRoot) {
    const harnessRoot = options.harnessRoot;
    tools.push({
      name: "status",
      description:
        "Current harness state: handoff, plan and open tickets, as reference data. Call when asked what is going on.",
      shape: {},
      run: async () => {
        const context = await buildContext(harnessRoot);
        return context ? cap(context, TOTAL_CHARS) : "No harness context is available.";
      },
    });
    tools.push({
      name: "open_tickets",
      description: "Open Linear MIC tickets from the local cache (read only).",
      shape: {},
      run: async () => {
        const body = await readTextFile(path.join(harnessRoot, TICKETS_CACHE_REL));
        return body ? cap(body, 3000) : "The ticket cache is empty.";
      },
    });
  }

  if (roots.length > 0) {
    tools.push({
      name: "read_file",
      description:
        "Read a text file under the Alchemist harness or the Workshop projects (path relative to either root).",
      shape: { path: z.string().describe("File path relative to the harness or Workshop root") },
      run: async (args) => {
        const file = await resolveInside(roots, String(args.path ?? ""));
        if (!file) return "Not allowed or not found.";
        const info = await stat(file);
        if (!info.isFile()) return "Not a file.";
        return cap(await readHead(file, READ_CHARS));
      },
    });
    tools.push({
      name: "search",
      description:
        "Find a case-insensitive text match in harness and Workshop text files. Returns file:line hits.",
      shape: { query: z.string().min(2).describe("Text to look for") },
      run: async (args) => {
        const needle = String(args.query ?? "").toLowerCase();
        if (needle.length < 2) return "Query too short.";
        const hits: string[] = [];
        for (const root of roots) {
          for await (const file of walk(root)) {
            if (hits.length >= SEARCH_HITS) break;
            let info;
            try {
              info = await stat(file);
            } catch {
              continue;
            }
            if (info.size > SEARCH_FILE_BYTES) continue;
            let text: string;
            try {
              text = await readFile(file, "utf8");
            } catch {
              continue;
            }
            const lines = text.split("\n");
            for (let i = 0; i < lines.length && hits.length < SEARCH_HITS; i++) {
              if (lines[i].toLowerCase().includes(needle)) {
                hits.push(
                  `${path.relative(root, file)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`,
                );
              }
            }
          }
        }
        return hits.length ? cap(hits.join("\n")) : "No matches.";
      },
    });
  }

  const agents = options.agents;
  if (agents) {
    tools.push({
      name: "list_agents",
      description: "List the Paseo agents and whether each is running, idle or failed.",
      shape: {},
      run: async () => {
        const list = await agents.list();
        if (list.length === 0) return "No agents.";
        return cap(
          list
            .map(
              (a) =>
                `${a.id} | ${a.status} | ${a.title ?? "untitled"}${a.provider ? ` | ${a.provider}` : ""}`,
            )
            .join("\n"),
        );
      },
    });
    tools.push({
      name: "read_agent_timeline",
      description:
        "Read the latest timeline of one Paseo agent, to summarize what it is doing aloud.",
      shape: {
        agentId: z.string().describe("Agent id from list_agents"),
        limit: z.number().int().min(1).max(60).optional().describe("How many recent items"),
      },
      run: async (args) => {
        const lines = await agents.timeline(String(args.agentId ?? ""), Number(args.limit ?? 20));
        return lines.length ? cap(lines.join("\n")) : "No timeline items.";
      },
    });
  }
  return tools;
}

export function allowedToolNames(tools: ToolDef[]): string[] {
  return tools.map((t) => `mcp__${TOOL_SERVER_NAME}__${t.name}`);
}
