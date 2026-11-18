// One Pi MCP capability probe per launch identity instead of one per create/resume.
// The answer (which extension owns /mcp) depends on the Pi launch command, the cwd
// (project .pi/settings.json, .pi/extensions), the agent dir (settings.json, extensions/,
// npm packages) and the launch env -- not on the agent's identity.
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import type { ProviderCommand } from "@getpaseo/protocol/provider-config";

export type PiMcpSupport = "adapter" | "builtin" | null;
export interface PiMcpProbeResult {
  support: PiMcpSupport;
  /** false when Pi did not start or get_commands failed; such results are not cached. */
  ok: boolean;
}
export interface PiMcpProbeInput {
  cwd: string;
  env: Record<string, string> | undefined;
  command: ProviderCommand | undefined;
  defaultCommand: string;
}

/** A found MCP mode is re-probed at least this often (bounds staleness after a Pi upgrade). */
export const PI_MCP_SUPPORT_TTL_MS = 10 * 60_000;
/** "No MCP" is retried soon. */
export const PI_MCP_NONE_TTL_MS = 60_000;
const MAX_ENTRIES = 256;
/**
 * Per-agent values Paseo adds to the launch env. Their values stay out of the key; whether each is
 * set stays in it, since a launch wrapper may branch on presence.
 */
const PER_AGENT_ENV = new Set(["PASEO_AGENT_ID", "PASEO_WORKSPACE_ID"]);

interface Entry {
  fingerprint: string;
  pending: Promise<PiMcpSupport> | null;
  support: PiMcpSupport;
  expiresAt: number;
}
const cache = new Map<string, Entry>();

async function stamp(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return s.ino + ":" + s.size + ":" + s.mtimeMs;
  } catch {
    return "-";
  }
}

async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return "-";
  }
}

function agentDir(env: Record<string, string>): string {
  const configured = (env.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR)?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

async function which(command: string | undefined, env: Record<string, string>): Promise<string> {
  if (!command) return "-";
  if (command.includes("/")) return resolve(command);
  for (const dir of (env.PATH ?? process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // next PATH entry
    }
  }
  return "-";
}

function launchArgv(input: PiMcpProbeInput): string[] {
  return input.command?.mode === "replace" ? input.command.argv : [input.defaultCommand];
}

/** Identity of a probe: launch command, cwd and agent-independent launch env (hashed). */
export function piMcpProbeKey(input: PiMcpProbeInput): string {
  const env = Object.entries(input.env ?? {})
    .map(([name, value]): [string, string | boolean] => [
      name,
      PER_AGENT_ENV.has(name) ? value !== "" : value,
    ])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash("sha256")
    .update(
      JSON.stringify({
        cwd: resolve(input.cwd),
        argv: launchArgv(input),
        command: input.command ?? null,
        env,
      }),
    )
    .digest("hex");
}

/** Cheap stat of the on-disk inputs of Pi's command set; any change forces a new probe. */
export async function piMcpProbeFingerprint(input: PiMcpProbeInput): Promise<string> {
  const env = input.env ?? {};
  const dir = agentDir(env);
  const cwd = resolve(input.cwd);
  const binary = await which(launchArgv(input)[0], env);
  const npm = join(dir, "npm");
  const parts = await Promise.all([
    real(binary),
    stamp(binary),
    stamp(join(dir, "settings.json")),
    stamp(join(dir, "extensions")),
    real(npm),
    stamp(npm),
    stamp(join(cwd, ".pi", "settings.json")),
    stamp(join(cwd, ".pi", "extensions")),
  ]);
  return [binary, ...parts].join("|");
}

/**
 * Return the cached MCP mode or run probe once for all concurrent callers with the same key.
 * A failed (ok: false) or throwing probe is returned to the caller but never cached.
 */
export async function cachedPiMcpSupport(
  input: PiMcpProbeInput,
  probe: () => Promise<PiMcpProbeResult>,
  now: () => number = Date.now,
): Promise<PiMcpSupport> {
  const key = piMcpProbeKey(input);
  // Awaited before the lookup, so concurrent callers resume in order and share one probe.
  const fingerprint = await piMcpProbeFingerprint(input);
  const hit = cache.get(key);
  if (hit && hit.fingerprint === fingerprint && (hit.pending || now() < hit.expiresAt)) {
    return hit.pending ?? hit.support;
  }
  const entry: Entry = { fingerprint, pending: null, support: null, expiresAt: 0 };
  entry.pending = Promise.resolve()
    .then(probe)
    .then(
      (result) => {
        if (cache.get(key) === entry) {
          if (result.ok) {
            entry.support = result.support;
            entry.expiresAt = now() + (entry.support ? PI_MCP_SUPPORT_TTL_MS : PI_MCP_NONE_TTL_MS);
            entry.pending = null;
          } else {
            cache.delete(key);
          }
        }
        return result.support;
      },
      (error: unknown) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      },
    );
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entry.pending;
}

/** Tests only. */
export function clearPiMcpSupportCache(): void {
  cache.clear();
}
