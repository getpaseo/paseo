import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic, readJsonIfExists } from "./atomic-write.js";
import {
  AGENT_INTEGRATIONS,
  canonicalSkillsDir,
  mcpConfigPathFor,
  skillsDirFor,
  type AgentIntegration,
} from "./agent-integrations.js";
import { mergeCodexConfig, type CodexEntry } from "./codex-toml-merge.js";
import { loadManifest, saveManifest, type SyncManifest } from "./sync-manifest.js";
import {
  TRANSPORT_BY_TARGET,
  type LibrarySyncTarget,
  type MaterializedMcpEntry,
  type MaterializedSkillEntry,
  type McpHttpPayload,
  type McpStdioPayload,
} from "./types.js";

/**
 * Optional per-path overrides, used mainly in tests to redirect `~` into a
 * tmp dir. The default paths always come from `AGENT_INTEGRATIONS` so the
 * production layout stays consistent with the registry.
 */
export interface SyncTargetPaths {
  /** Override the canonical skills dir (default `~/.agentskills`). */
  skillsDir: string;
  /** Override per-agent MCP config paths, keyed by integration id. */
  agentConfigPaths: Record<string, string>;
  /** Override per-agent skill directories, keyed by integration id. */
  agentSkillsDirs: Record<string, (skillId: string) => string>;
}

export function defaultSyncPaths(home: string = os.homedir()): SyncTargetPaths {
  const agentConfigPaths: Record<string, string> = {};
  const agentSkillsDirs: Record<string, (skillId: string) => string> = {};
  for (const a of AGENT_INTEGRATIONS) {
    const cfg = mcpConfigPathFor(a, home);
    if (cfg) agentConfigPaths[a.id] = cfg;
    if (a.skills) agentSkillsDirs[a.id] = (skillId) => skillsDirFor(a, skillId, home)!;
  }
  return {
    skillsDir: canonicalSkillsDir(home),
    agentConfigPaths,
    agentSkillsDirs,
  };
}

export interface SyncInput {
  hubcodeHome: string;
  paths?: Partial<SyncTargetPaths>;
  mcps: MaterializedMcpEntry[];
  skills: MaterializedSkillEntry[];
}

export interface SyncReport {
  manifest: SyncManifest;
  /** Targets that were touched this run. */
  touched: LibrarySyncTarget[];
  /** Number of entries written per target. Dynamic record so new agents don't break callers. */
  counts: Record<string, { mcp: number; skill: number }>;
}

/**
 * Run a full sync pass: write each target's external config, write canonical
 * skill files + symlinks, update manifest. Idempotent.
 */
export async function syncLibraryToTargets(input: SyncInput): Promise<SyncReport> {
  const paths = mergeSyncPaths(defaultSyncPaths(), input.paths);
  const manifest = await loadManifest(input.hubcodeHome);
  const touched = new Set<LibrarySyncTarget>();
  const counts: Record<string, { mcp: number; skill: number }> = {};
  for (const a of AGENT_INTEGRATIONS) counts[a.id] = { mcp: 0, skill: 0 };

  const mcpsByTarget = bucketByTarget(input.mcps);
  const skillsByTarget = bucketSkills(input.skills);

  for (const agent of AGENT_INTEGRATIONS) {
    if (!agent.mcp) continue;
    const targetId = agent.id as LibrarySyncTarget;
    const bucket = mcpsByTarget[targetId] ?? [];
    const supported = bucket.filter((e) =>
      agent.mcp!.supportsHttp ? true : e.payload.transport === "stdio",
    );
    counts[agent.id]!.mcp = supported.length;
    const configPath = paths.agentConfigPaths[agent.id] ?? mcpConfigPathFor(agent);
    if (!configPath) continue;
    await writeMcpsForAgent({
      agent,
      configPath,
      entries: supported,
      previousKeys: manifest.targets[agent.id]?.mcpKeys ?? [],
    });
    manifest.targets[agent.id] = {
      ...(manifest.targets[agent.id] ?? { mcpKeys: [], skillKeys: [] }),
      mcpKeys: supported.map((e) => e.name),
    };
    if (supported.length > 0) touched.add(targetId);
  }

  // Skills — canonical file at `~/.agentskills/<id>/SKILL.md`, then per-agent
  // symlink under the agent's skills dir. Edit once, all agents see it.
  const skillsForAll = dedupeSkills(input.skills);
  const previousSkillKeysByTarget: Record<string, string[]> = {};
  for (const a of AGENT_INTEGRATIONS) {
    previousSkillKeysByTarget[a.id] = manifest.targets[a.id]?.skillKeys ?? [];
  }
  const previousSkillKeys = unique(Object.values(previousSkillKeysByTarget).flat());
  await writeCanonicalSkills({
    skillsDir: paths.skillsDir,
    entries: skillsForAll,
    previousKeys: previousSkillKeys,
  });
  await mirrorSkillSymlinks({
    canonicalDir: paths.skillsDir,
    skillsByTarget,
    previousSkillKeysByTarget,
    agentSkillsDirs: paths.agentSkillsDirs,
  });
  for (const agent of AGENT_INTEGRATIONS) {
    if (!agent.skills) continue;
    const targetId = agent.id as LibrarySyncTarget;
    const entries = skillsByTarget[targetId] ?? [];
    counts[agent.id]!.skill = entries.length;
    manifest.targets[agent.id] = {
      ...(manifest.targets[agent.id] ?? { mcpKeys: [], skillKeys: [] }),
      skillKeys: entries.map((e) => e.name),
    };
    if (entries.length > 0) touched.add(targetId);
  }

  manifest.lastSyncAt = new Date().toISOString();
  await saveManifest(input.hubcodeHome, manifest);

  return { manifest, touched: Array.from(touched), counts };
}

function mergeSyncPaths(
  base: SyncTargetPaths,
  partial: Partial<SyncTargetPaths> | undefined,
): SyncTargetPaths {
  if (!partial) return base;
  return {
    skillsDir: partial.skillsDir ?? base.skillsDir,
    agentConfigPaths: { ...base.agentConfigPaths, ...(partial.agentConfigPaths ?? {}) },
    agentSkillsDirs: { ...base.agentSkillsDirs, ...(partial.agentSkillsDirs ?? {}) },
  };
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function emptyTargetBucket<T>(): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const a of AGENT_INTEGRATIONS) out[a.id] = [];
  return out;
}

function bucketByTarget(mcps: MaterializedMcpEntry[]): Record<string, MaterializedMcpEntry[]> {
  const out = emptyTargetBucket<MaterializedMcpEntry>();
  for (const entry of mcps) {
    for (const target of entry.syncTargets) {
      const allowed = TRANSPORT_BY_TARGET[target];
      if (!allowed || !allowed.includes(entry.payload.transport)) continue;
      (out[target] ??= []).push(entry);
    }
  }
  return out;
}

function bucketSkills(skills: MaterializedSkillEntry[]): Record<string, MaterializedSkillEntry[]> {
  const out = emptyTargetBucket<MaterializedSkillEntry>();
  for (const entry of skills) {
    for (const target of entry.syncTargets) (out[target] ??= []).push(entry);
  }
  return out;
}

function dedupeSkills(skills: MaterializedSkillEntry[]): MaterializedSkillEntry[] {
  const seen = new Set<string>();
  const out: MaterializedSkillEntry[] = [];
  for (const entry of skills) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}

// ─── MCP dispatch ────────────────────────────────────────────────────────

async function writeMcpsForAgent(args: {
  agent: AgentIntegration;
  configPath: string;
  entries: MaterializedMcpEntry[];
  previousKeys: string[];
}): Promise<void> {
  const { adapter } = args.agent.mcp!;
  switch (adapter) {
    case "passthrough":
      // Claude, Amp, Droid — all use the same `mcpServers` shape with
      // either { command, args, env } for stdio or { type, url, headers }
      // for http/sse.
      return writeJsonMcps({
        ...args,
        serversKey: args.agent.mcp!.serversPath[0]!,
        toEntry: toClaudeEntry,
      });
    case "codex":
      return writeCodexMcps(args);
    case "opencode":
      return writeOpenCodeMcps(args);
    case "cursor":
      return writeJsonMcps({
        ...args,
        serversKey: args.agent.mcp!.serversPath[0]!,
        toEntry: toCursorEntry,
      });
    case "gemini":
      return writeJsonMcps({
        ...args,
        serversKey: args.agent.mcp!.serversPath[0]!,
        toEntry: toGeminiEntry,
      });
    case "copilot":
      return writeJsonMcps({
        ...args,
        serversKey: args.agent.mcp!.serversPath[0]!,
        toEntry: toCopilotEntry,
      });
  }
}

/**
 * Generic JSON writer used by every adapter that lands a dict under a single
 * top-level key. `toEntry` shapes the canonical payload into the adapter's
 * native object.
 */
async function writeJsonMcps(args: {
  configPath: string;
  entries: MaterializedMcpEntry[];
  previousKeys: string[];
  serversKey: string;
  toEntry: (payload: MaterializedMcpEntry["payload"]) => unknown;
}): Promise<void> {
  const existing = (await readJsonIfExists<Record<string, unknown>>(args.configPath)) ?? {};
  const previousOwned = new Set(args.previousKeys);
  const existingServers = (existing[args.serversKey] as Record<string, unknown> | undefined) ?? {};
  const servers: Record<string, unknown> = { ...existingServers };

  for (const key of previousOwned) {
    if (key in servers) delete servers[key];
  }
  for (const entry of args.entries) {
    if (key_userManaged(entry.name, existingServers, previousOwned)) continue;
    servers[entry.name] = args.toEntry(entry.payload);
  }

  const next: Record<string, unknown> = { ...existing, [args.serversKey]: servers };
  await writeFileAtomic(args.configPath, JSON.stringify(next, null, 2), { mode: 0o600 });
}

// ─── Adapter shapers (canonical payload → each agent's native shape) ───

type ClaudeMcpEntry =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/** Claude / Amp / Droid — `{ command, args, env }` or `{ type, url, headers }`. */
function toClaudeEntry(payload: MaterializedMcpEntry["payload"]): ClaudeMcpEntry {
  if (payload.transport === "stdio") {
    const stdio = payload as McpStdioPayload;
    return {
      command: stdio.command,
      ...(stdio.args && stdio.args.length > 0 ? { args: stdio.args } : {}),
      ...(stdio.env && Object.keys(stdio.env).length > 0 ? { env: stdio.env } : {}),
    };
  }
  const http = payload as McpHttpPayload;
  return {
    type: http.transport,
    url: http.url,
    ...(http.headers && Object.keys(http.headers).length > 0 ? { headers: http.headers } : {}),
  };
}

/**
 * Cursor — stdio identical to passthrough; http uses `{ url, headers }` with
 * no `type` discriminator.
 */
function toCursorEntry(payload: MaterializedMcpEntry["payload"]): unknown {
  if (payload.transport === "stdio") {
    return toClaudeEntry(payload);
  }
  const http = payload as McpHttpPayload;
  return {
    url: http.url,
    ...(http.headers && Object.keys(http.headers).length > 0 ? { headers: http.headers } : {}),
  };
}

/**
 * Gemini / Qwen — stdio is passthrough; http uses `{ httpUrl, headers }` and
 * requires the SSE-friendly Accept header.
 */
function toGeminiEntry(payload: MaterializedMcpEntry["payload"]): unknown {
  if (payload.transport === "stdio") {
    return toClaudeEntry(payload);
  }
  const http = payload as McpHttpPayload;
  const headers: Record<string, string> = { ...(http.headers ?? {}) };
  if (!headers.Accept) {
    headers.Accept = "application/json, text/event-stream";
  }
  return { httpUrl: http.url, headers };
}

/**
 * GitHub Copilot — same shape as Claude but auto-adds `tools: ["*"]` so the
 * server's tools are allowlisted by default. Matches Emdash's behavior.
 */
function toCopilotEntry(payload: MaterializedMcpEntry["payload"]): unknown {
  const base = toClaudeEntry(payload);
  return { ...base, tools: ["*"] };
}

function key_userManaged(
  name: string,
  existing: Record<string, unknown>,
  previousOwned: Set<string>,
): boolean {
  return !previousOwned.has(name) && name in existing;
}

// ─── Codex (TOML) ────────────────────────────────────────────────────────

async function writeCodexMcps(args: {
  configPath: string;
  entries: MaterializedMcpEntry[];
  previousKeys: string[];
}): Promise<void> {
  const previous = await readTextIfExists(args.configPath);
  const codexEntries: CodexEntry[] = args.entries.flatMap((entry) => {
    if (entry.payload.transport !== "stdio") return [];
    const stdio = entry.payload as McpStdioPayload;
    return [
      {
        key: entry.name,
        command: stdio.command,
        args: stdio.args,
        env: stdio.env,
      },
    ];
  });
  const merged = mergeCodexConfig({
    previousSource: previous ?? "",
    nextEntries: codexEntries,
    previousOwnedKeys: args.previousKeys,
  });
  await writeFileAtomic(args.configPath, merged, { mode: 0o600 });
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ─── OpenCode (jsonc) ───────────────────────────────────────────────────

interface OpenCodeJson {
  mcp?: Record<string, OpenCodeMcpEntry>;
  [key: string]: unknown;
}

type OpenCodeMcpEntry =
  | { type: "local"; command: string[]; environment?: Record<string, string> }
  | { type: "remote"; url: string; headers?: Record<string, string> };

async function writeOpenCodeMcps(args: {
  configPath: string;
  entries: MaterializedMcpEntry[];
  previousKeys: string[];
}): Promise<void> {
  const existing = (await readJsonIfExists<OpenCodeJson>(args.configPath)) ?? {};
  const previousOwned = new Set(args.previousKeys);
  const servers = { ...(existing.mcp ?? {}) };

  for (const key of previousOwned) {
    if (key in servers) delete servers[key];
  }

  for (const entry of args.entries) {
    if (key_userManaged(entry.name, existing.mcp ?? {}, previousOwned)) continue;
    servers[entry.name] = toOpenCodeEntry(entry.payload);
  }

  const next: OpenCodeJson = { ...existing, mcp: servers };
  await writeFileAtomic(args.configPath, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function toOpenCodeEntry(payload: MaterializedMcpEntry["payload"]): OpenCodeMcpEntry {
  if (payload.transport === "stdio") {
    const stdio = payload as McpStdioPayload;
    const argv = [stdio.command, ...(stdio.args ?? [])];
    return {
      type: "local",
      command: argv,
      ...(stdio.env && Object.keys(stdio.env).length > 0 ? { environment: stdio.env } : {}),
    };
  }
  const http = payload as McpHttpPayload;
  return {
    type: "remote",
    url: http.url,
    ...(http.headers && Object.keys(http.headers).length > 0 ? { headers: http.headers } : {}),
  };
}

// ─── Skills — canonical + symlinks ─────────────────────────────────────

async function writeCanonicalSkills(args: {
  skillsDir: string;
  entries: MaterializedSkillEntry[];
  previousKeys: string[];
}): Promise<void> {
  const nextKeys = new Set(args.entries.map((e) => e.name));
  for (const stale of args.previousKeys) {
    if (nextKeys.has(stale)) continue;
    await removeDirSafe(path.join(args.skillsDir, stale));
  }
  for (const entry of args.entries) {
    const folder = path.join(args.skillsDir, entry.name);
    const file = path.join(folder, "SKILL.md");
    await writeFileAtomic(file, renderSkillFile(entry), { mode: 0o600 });
  }
}

async function mirrorSkillSymlinks(args: {
  canonicalDir: string;
  skillsByTarget: Record<string, MaterializedSkillEntry[]>;
  previousSkillKeysByTarget: Record<string, string[]>;
  agentSkillsDirs: Record<string, (skillId: string) => string>;
}): Promise<void> {
  for (const agent of AGENT_INTEGRATIONS) {
    if (!agent.skills) continue;
    const dirFn = args.agentSkillsDirs[agent.id];
    if (!dirFn) continue;

    const activeEntries = args.skillsByTarget[agent.id] ?? [];
    const nextKeys = new Set(activeEntries.map((e) => e.name));

    for (const stale of args.previousSkillKeysByTarget[agent.id] ?? []) {
      if (nextKeys.has(stale)) continue;
      await removeFileSafe(dirFn(stale));
    }

    for (const entry of activeEntries) {
      const canonical = path.join(args.canonicalDir, entry.name);
      const symlinkPath = dirFn(entry.name);
      await ensureSymlink(canonical, symlinkPath);
    }
  }
}

async function ensureSymlink(target: string, linkPath: string): Promise<void> {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  try {
    const existing = await fs.readlink(linkPath).catch(() => null);
    if (existing === target) return; // already linked correctly
    // If a file/dir exists there, remove it — we own these paths via manifest.
    await fs.rm(linkPath, { recursive: true, force: true });
  } catch {
    /* fallthrough */
  }
  try {
    await fs.symlink(target, linkPath, "dir");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Windows without dev-mode perms → fall back to copy. Not ideal but the
    // file stays in sync on the next sync pass.
    if (code === "EPERM" || code === "EACCES") {
      await copyDir(target, linkPath);
      return;
    }
    throw err;
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

function renderSkillFile(entry: MaterializedSkillEntry): string {
  const inline = entry.payload.instructionsInline?.trim() ?? "";
  if (inline.length > 0) return ensureTrailingNewline(inline);
  if (entry.payload.instructionsUrl) {
    return ensureTrailingNewline(
      `# ${entry.displayName ?? entry.name}\n\nSee: ${entry.payload.instructionsUrl}`,
    );
  }
  return `# ${entry.displayName ?? entry.name}\n\n${entry.description ?? ""}\n`;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

async function removeDirSafe(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore — best-effort cleanup
  }
}

async function removeFileSafe(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
