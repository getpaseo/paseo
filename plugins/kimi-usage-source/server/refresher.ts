import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LEAD_MS = 3 * 60_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const MINIMUM_TOKEN_LIFETIME_MS = 60_000;

export interface KimiCredentialSnapshot {
  path: string;
  exists: boolean;
  expiresAtMs: number | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}

export type KimiCredentialRefreshOutcome =
  | { status: "refreshed"; expiresAtMs: number }
  | { status: "not-needed" | "external-token" | "login-required" | "missing" }
  | { status: "failed"; error: string };

interface RefreshResult {
  ok: boolean;
  error?: string;
}

interface RefreshOptions {
  readCredentials?: () => Promise<KimiCredentialSnapshot>;
  launchRefresh?: (before: KimiCredentialSnapshot, signal: AbortSignal) => Promise<RefreshResult>;
  now?: () => number;
  leadMs?: number;
  signal?: AbortSignal;
}

function envDuration(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), ".kimi-code");
}

export function credentialPath(): string {
  return join(kimiHome(), "credentials", "kimi-code.json");
}

function resolveKimiCommand(): string {
  const commandNames = process.platform === "win32" ? ["kimi.EXE", "kimi.exe", "kimi"] : ["kimi"];
  for (const name of commandNames) {
    const candidate = join(kimiHome(), "bin", name);
    if (existsSync(candidate)) return candidate;
  }
  return "kimi";
}

async function readCredentials(path = credentialPath()): Promise<KimiCredentialSnapshot> {
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const expiresAt = Number(parsed.expires_at);
    return {
      path,
      exists: true,
      expiresAtMs: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt * 1000 : null,
      hasAccessToken:
        typeof parsed.access_token === "string" && parsed.access_token.trim().length > 0,
      hasRefreshToken:
        typeof parsed.refresh_token === "string" && parsed.refresh_token.trim().length > 0,
    };
  } catch {
    return {
      path,
      exists: false,
      expiresAtMs: null,
      hasAccessToken: false,
      hasRefreshToken: false,
    };
  }
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate a local port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function sanitizeProcessOutput(value: string): string {
  return value
    .replace(/#token=[A-Za-z0-9._~-]+/gi, "#token=<redacted>")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/\b(?:at|rt)_[A-Za-z0-9._~-]+/g, "<redacted>")
    .replace(/([?&](?:token|access_token|refresh_token)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-500);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    delay(3_000).then(() => false),
  ]);
  if (exited || process.platform !== "win32" || child.pid === undefined) return;

  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await Promise.race([once(killer, "exit"), delay(3_000)]);
}

async function launchKimiRefresh(
  before: KimiCredentialSnapshot,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<RefreshResult> {
  const port = await findFreePort();
  const child = spawn(
    resolveKimiCommand(),
    ["web", "--no-open", "--port", String(port), "--log-level", "warn"],
    {
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let spawnError = "";
  const collect = (chunk: Buffer | string) => {
    output = (output + chunk.toString()).slice(-4_096);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.once("error", (error) => {
    spawnError = error.message;
  });

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) return { ok: false, error: "Refresh cancelled" };
      const after = await readCredentials(before.path);
      if (
        after.expiresAtMs !== null &&
        after.expiresAtMs >= Date.now() + MINIMUM_TOKEN_LIFETIME_MS &&
        (before.expiresAtMs === null || after.expiresAtMs > before.expiresAtMs + 30_000)
      ) {
        return { ok: true };
      }
      if (spawnError || child.pid === undefined) {
        return {
          ok: false,
          error: `Unable to start kimi web: ${sanitizeProcessOutput(spawnError || "not started")}`,
        };
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const detail = sanitizeProcessOutput(output || spawnError);
        return {
          ok: false,
          error: `kimi web exited early${detail ? `: ${detail}` : ""}`,
        };
      }
      await delay(300);
    }
    const detail = sanitizeProcessOutput(output);
    return {
      ok: false,
      error: `Timed out waiting for Kimi to refresh credentials${detail ? `: ${detail}` : ""}`,
    };
  } finally {
    await stopChild(child);
  }
}

export async function refreshKimiCredentialsIfNeeded(
  options: RefreshOptions = {},
): Promise<KimiCredentialRefreshOutcome> {
  if (options.signal?.aborted) return { status: "not-needed" };
  const now = options.now ?? Date.now;
  const read = options.readCredentials ?? readCredentials;
  const before = await read();

  if (!before.exists || !before.hasAccessToken) {
    return process.env.KIMI_TOKEN || process.env.KIMI_API_KEY
      ? { status: "external-token" }
      : { status: "missing" };
  }
  if (before.expiresAtMs === null) return { status: "not-needed" };
  if (before.expiresAtMs - now() > (options.leadMs ?? DEFAULT_LEAD_MS))
    return { status: "not-needed" };
  if (!before.hasRefreshToken) return { status: "login-required" };

  const timeoutMs = envDuration("PASEO_KIMI_REFRESH_TIMEOUT_MS", DEFAULT_REFRESH_TIMEOUT_MS, 5_000);
  const launch =
    options.launchRefresh ?? ((state, signal) => launchKimiRefresh(state, signal, timeoutMs));
  const abort = options.signal ?? new AbortController().signal;
  const result = await launch(before, abort);
  if (!result.ok) return { status: "failed", error: result.error ?? "Unknown error" };

  const after = await read();
  if (
    after.expiresAtMs !== null &&
    after.expiresAtMs >= now() + MINIMUM_TOKEN_LIFETIME_MS &&
    (before.expiresAtMs === null || after.expiresAtMs > before.expiresAtMs + 30_000)
  ) {
    return { status: "refreshed", expiresAtMs: after.expiresAtMs };
  }
  return { status: "failed", error: "Kimi CLI exited without updating the credential" };
}

export function startKimiCredentialRefresh(): () => void {
  const disabled = process.env.PASEO_KIMI_REFRESH_DISABLED === "1";
  const intervalMs = envDuration("PASEO_KIMI_REFRESH_INTERVAL_MS", DEFAULT_INTERVAL_MS, 5_000);
  const leadMs = envDuration("PASEO_KIMI_REFRESH_LEAD_MS", DEFAULT_LEAD_MS, 30_000);
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let nextAllowedAt = 0;
  let lastMessage = "";

  const logOnce = (message: string) => {
    if (message === lastMessage) return;
    lastMessage = message;
    console.log(`[kimi-usage-source] ${message}`);
  };

  const check = async () => {
    if (stopped || running || disabled) return;
    running = true;
    try {
      if (Date.now() < nextAllowedAt) return;
      const outcome = await refreshKimiCredentialsIfNeeded({
        leadMs,
        signal: abort.signal,
      });
      if (outcome.status === "refreshed") {
        nextAllowedAt = 0;
        logOnce(`Kimi credentials refreshed until ${new Date(outcome.expiresAtMs).toISOString()}`);
      } else if (outcome.status === "login-required") {
        logOnce("Kimi refresh token is unavailable; run kimi login");
      } else if (outcome.status === "failed") {
        nextAllowedAt = Date.now() + FAILURE_COOLDOWN_MS;
        logOnce(`Kimi credential refresh failed; retrying in 5 minutes: ${outcome.error}`);
      }
    } catch (error) {
      nextAllowedAt = Date.now() + FAILURE_COOLDOWN_MS;
      const message = error instanceof Error ? error.message : String(error);
      logOnce(
        `Kimi credential refresh failed; retrying in 5 minutes: ${sanitizeProcessOutput(message)}`,
      );
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await check();
      schedule();
    }, intervalMs);
  };

  if (!disabled) {
    console.log(`[kimi-usage-source] watching ${credentialPath()}`);
    void check().finally(schedule);
  }

  return () => {
    stopped = true;
    abort.abort();
    if (timer) clearTimeout(timer);
  };
}
