import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface HermesProfileCommand {
  profileHome(profile: string): Promise<string | null>;
  createProfile(profile: string, sourceProfile: string): Promise<string>;
  deleteProfile(profile: string): Promise<void>;
  ensureRuntimeState(
    profile: string,
    sourceProfile: string,
    home: string,
    includeRuntimeState: boolean,
    runtimeSessionId?: string,
  ): Promise<void>;
  hardenProfile(profile: string, home: string): Promise<void>;
}

export interface HermesProfileAssignment {
  profile: string;
  home: string;
}

interface HermesProfileManagerOptions {
  command: HermesProfileCommand;
  sourceProfile?: string;
}

interface PrepareHermesProfileOptions {
  includeRuntimeState?: boolean;
  runtimeSessionId?: string;
}

export class HermesProfileManager {
  private readonly command: HermesProfileCommand;
  private readonly sourceProfile: string;
  private readonly pending = new Map<string, Promise<HermesProfileAssignment>>();

  constructor(options: HermesProfileManagerOptions) {
    this.command = options.command;
    this.sourceProfile = options.sourceProfile ?? "default";
  }

  prepare(
    agentId: string,
    options: PrepareHermesProfileOptions = {},
  ): Promise<HermesProfileAssignment> {
    const profile = profileNameForAgent(agentId);
    const includeRuntimeState = options.includeRuntimeState ?? false;
    const runtimeSessionId = options.runtimeSessionId;
    const pendingKey = `${profile}:${includeRuntimeState ? (runtimeSessionId ?? "resume") : "fresh"}`;
    const existing = this.pending.get(pendingKey);
    if (existing) return existing;

    const operation = this.prepareProfile(profile, includeRuntimeState, runtimeSessionId).finally(
      () => {
        this.pending.delete(pendingKey);
      },
    );
    this.pending.set(pendingKey, operation);
    return operation;
  }

  delete(agentId: string): Promise<void> {
    return this.command.deleteProfile(profileNameForAgent(agentId));
  }

  private async prepareProfile(
    profile: string,
    includeRuntimeState: boolean,
    runtimeSessionId?: string,
  ): Promise<HermesProfileAssignment> {
    const home = await this.command.createProfile(profile, this.sourceProfile);
    await this.command.ensureRuntimeState(
      profile,
      this.sourceProfile,
      home,
      includeRuntimeState,
      runtimeSessionId,
    );
    await this.command.hardenProfile(profile, home);
    return { profile, home };
  }
}

export function profileNameForAgent(agentId: string): string {
  const digest = createHash("sha256").update(agentId).digest("hex").slice(0, 16);
  return `paseo-${digest}`;
}

interface HermesCliProfileCommandOptions {
  executable: string;
  env?: Record<string, string>;
}

export class HermesCliProfileCommand implements HermesProfileCommand {
  private readonly executable: string;
  private readonly env?: Record<string, string>;
  private readonly runtimeSnapshots = new Map<string, Promise<string>>();

  constructor(options: HermesCliProfileCommandOptions) {
    this.executable = options.executable;
    this.env = options.env;
  }

  async profileHome(profile: string): Promise<string | null> {
    const result = await this.run(["profile", "show", profile], true);
    if (result.exitCode !== 0) return null;

    const home = /^Path:\s+(.+)$/mu.exec(result.stdout)?.[1]?.trim();
    if (!home) {
      throw new Error(`Hermes profile '${profile}' exists but did not report its home path`);
    }
    return home;
  }

  async createProfile(profile: string, sourceProfile: string): Promise<string> {
    return this.withProfileLock(profile, async () => {
      const existing = await this.profileHome(profile);
      if (existing) {
        await this.ensureBaselineLocked(sourceProfile, existing);
        return existing;
      }
      return this.createProfileLocked(profile, sourceProfile);
    });
  }

  async deleteProfile(profile: string): Promise<void> {
    return this.withProfileLock(profile, async () => {
      if (!(await this.profileHome(profile))) return;
      await this.run(["profile", "delete", "-y", profile], false);
    });
  }

  private async createProfileLocked(profile: string, sourceProfile: string): Promise<string> {
    const sourceHome = await this.profileHome(sourceProfile);
    if (!sourceHome) {
      throw new Error(`Hermes source profile '${sourceProfile}' does not exist`);
    }
    const result = await this.run(
      [
        "profile",
        "create",
        profile,
        "--no-alias",
        "--no-skills",
        "--description",
        "Paseo-managed isolated Hermes agent profile.",
      ],
      true,
    );
    if (result.exitCode !== 0) {
      const racedHome = await this.profileHome(profile);
      if (racedHome) return racedHome;
      const detail = result.stderr.trim() || result.stdout.trim() || "no command output";
      throw new Error(`Hermes profile command failed with exit code ${result.exitCode}: ${detail}`);
    }
    const reportedHome = /^Profile directory:\s+(.+)$/mu.exec(result.stdout)?.[1]?.trim();
    const home = reportedHome ?? (await this.profileHome(profile));
    if (!home) {
      throw new Error(
        `Hermes created profile '${profile}' but its home path could not be resolved`,
      );
    }
    await this.ensureBaselineLocked(sourceProfile, home, sourceHome);
    return home;
  }

  private async ensureBaselineLocked(
    sourceProfile: string,
    home: string,
    knownSourceHome?: string,
  ): Promise<void> {
    const marker = join(home, ".paseo-baseline-ready");
    if (await pathExists(marker)) return;

    const sourceHome = knownSourceHome ?? (await this.profileHome(sourceProfile));
    if (!sourceHome) {
      throw new Error(`Hermes source profile '${sourceProfile}' does not exist`);
    }
    await this.copyBaseline(sourceHome, home);
    if (!(await pathExists(join(home, ".paseo-runtime-state-ready")))) {
      await resetProfileMemory(home);
    }
    await atomicWriteFile(marker, "ready\n", 0o600);
  }

  private async copyBaseline(sourceHome: string, targetHome: string): Promise<void> {
    for (const file of ["config.yaml", ".env", "SOUL.md"]) {
      const source = join(sourceHome, file);
      if (!(await pathExists(source))) continue;
      const target = join(targetHome, file);
      await copyFile(source, target);
      if (file === ".env") await chmod(target, 0o600);
    }

    const sourceSkills = join(sourceHome, "skills");
    if (await pathExists(sourceSkills)) {
      await cp(sourceSkills, join(targetHome, "skills"), { recursive: true, force: true });
    }
  }

  private async withProfileLock<T>(profile: string, operation: () => Promise<T>): Promise<T> {
    const homeScope = this.env?.HOME ?? process.env.HOME ?? "unknown-home";
    const scope = createHash("sha256").update(homeScope).digest("hex").slice(0, 12);
    const lock = join(tmpdir(), `paseo-hermes-profile-${scope}-${profile}.lock`);
    const deadline = Date.now() + PROFILE_CREATION_LOCK_TIMEOUT_MS;

    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = await stat(lock)
          .then((entry) => Date.now() - entry.mtimeMs)
          .catch(() => 0);
        if (age > PROFILE_CREATION_LOCK_STALE_MS) {
          await this.quarantineStaleLock(lock);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting to create Hermes profile '${profile}'`, {
            cause: error,
          });
        }
        await delay(PROFILE_CREATION_LOCK_POLL_MS);
      }
    }

    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lock, now, now).catch(() => undefined);
    }, PROFILE_CREATION_LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await rm(lock, { recursive: true, force: true });
    }
  }

  private async quarantineStaleLock(lock: string): Promise<void> {
    const quarantine = `${lock}.stale-${randomUUID()}`;
    try {
      await rename(lock, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(quarantine, { recursive: true, force: true });
  }

  async ensureRuntimeState(
    profile: string,
    sourceProfile: string,
    home: string,
    includeRuntimeState: boolean,
    runtimeSessionId?: string,
  ): Promise<void> {
    return this.withProfileLock(profile, () =>
      this.ensureRuntimeStateLocked(
        profile,
        sourceProfile,
        home,
        includeRuntimeState,
        runtimeSessionId,
      ),
    );
  }

  private async ensureRuntimeStateLocked(
    profile: string,
    sourceProfile: string,
    home: string,
    includeRuntimeState: boolean,
    runtimeSessionId?: string,
  ): Promise<void> {
    const marker = join(home, ".paseo-runtime-state-ready");
    try {
      await readFile(marker, "utf8");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await resetProfileMemory(home);

    if (includeRuntimeState) {
      if (!runtimeSessionId) {
        throw new Error(
          `Hermes profile '${profile}' runtime migration requires a native session ID`,
        );
      }
      const snapshot = await this.runtimeSnapshot(sourceProfile, profile);
      await copyFile(join(snapshot, "state.db"), join(home, "state.db"));
      await retainOnlyRuntimeSession(join(home, "state.db"), runtimeSessionId);
    }

    await atomicWriteFile(marker, `${includeRuntimeState ? "migrated" : "fresh"}\n`, 0o600);
  }

  private runtimeSnapshot(sourceProfile: string, profile: string): Promise<string> {
    const existing = this.runtimeSnapshots.get(sourceProfile);
    if (existing) return existing;

    const snapshot = this.createRuntimeSnapshot(sourceProfile, profile).catch((error) => {
      this.runtimeSnapshots.delete(sourceProfile);
      throw error;
    });
    this.runtimeSnapshots.set(sourceProfile, snapshot);
    void snapshot.then(
      (path) => {
        return setTimeout(() => {
          if (this.runtimeSnapshots.get(sourceProfile) !== snapshot) return;
          this.runtimeSnapshots.delete(sourceProfile);
          void rm(path, { recursive: true, force: true }).catch(() => undefined);
        }, RUNTIME_SNAPSHOT_TTL_MS).unref();
      },
      () => undefined,
    );
    return snapshot;
  }

  private async createRuntimeSnapshot(sourceProfile: string, profile: string): Promise<string> {
    const label = `${profile}-${randomUUID()}`;
    const sourceHome = await this.profileHome(sourceProfile);
    if (!sourceHome) {
      throw new Error(`Hermes source profile '${sourceProfile}' has no home for runtime migration`);
    }
    const backup = await this.run(
      ["--profile", sourceProfile, "backup", "--quick", "--label", label],
      false,
    );
    const snapshotId = /^State snapshot created:\s+(.+)$/mu.exec(backup.stdout)?.[1]?.trim();
    if (!snapshotId) {
      throw new Error(`Hermes did not create a runtime snapshot for profile '${sourceProfile}'`);
    }
    return join(sourceHome, "state-snapshots", snapshotId);
  }

  async hardenProfile(profile: string, home: string): Promise<void> {
    return this.withProfileLock(profile, () => this.hardenProfileLocked(profile, home));
  }

  private async hardenProfileLocked(profile: string, home: string): Promise<void> {
    const configPath = join(home, "config.yaml");
    const config = await readFile(configPath, "utf8");
    const hardened = sanitizeProfileConfig(config);
    await atomicWriteFile(configPath, hardened, 0o600);
    if (
      sanitizeProfileConfig(hardened) !== hardened ||
      /claude[-_]mem/imu.test(hardened) ||
      hasExternalMemoryProvider(hardened)
    ) {
      throw new Error(`Hermes profile '${profile}' external memory configuration was not hardened`);
    }
  }

  private run(args: string[], allowFailure: boolean): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, {
        env: { ...process.env, ...this.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        const exitCode = code ?? 1;
        if (exitCode === 0 || allowFailure) {
          resolve({ exitCode, stdout, stderr });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || "no command output";
        reject(
          new Error(
            `Hermes profile command failed with ${signal ? `signal ${signal}` : `exit code ${exitCode}`}: ${detail}`,
          ),
        );
      });
    });
  }
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_COMMAND_OUTPUT = 16_384;
const RUNTIME_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const PROFILE_CREATION_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const PROFILE_CREATION_LOCK_STALE_MS = 5 * 60 * 1000;
const PROFILE_CREATION_LOCK_POLL_MS = 100;
const PROFILE_CREATION_LOCK_HEARTBEAT_MS = 30 * 1000;

function isClaudeMemIdentifier(value: string | undefined): boolean {
  return ["claude-mem", "claude_mem", "claude-mem-bridge", "claude_mem_bridge"].includes(
    value ?? "",
  );
}

function isInlineMemoryConfig(trimmed: string, indent: number): boolean {
  return indent === 0 && /^["']?memory["']?\s*:\s*\{/u.test(trimmed);
}

function sanitizeProfileConfig(config: string): string {
  const output: string[] = [];
  let topLevel = "";
  let skippedIndent: number | null = null;

  for (const line of config.split("\n")) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (isInlineMemoryConfig(trimmed, indent)) {
      topLevel = "memory";
      output.push("memory:", "  provider:");
      skippedIndent = null;
      continue;
    }
    if (skippedIndent !== null) {
      if (!trimmed || indent > skippedIndent) continue;
      skippedIndent = null;
    }
    if (indent === 0 && trimmed.endsWith(":")) {
      topLevel = trimmed.slice(0, -1).replaceAll(/["']/gu, "");
    }

    const key = trimmed.split(":", 1)[0]?.replaceAll(/["']/gu, "");
    if (topLevel === "memory" && indent > 0 && key === "provider") {
      output.push("  provider:");
      continue;
    }
    if (topLevel === "mcp_servers" && indent > 0 && isClaudeMemIdentifier(key)) {
      skippedIndent = indent;
      continue;
    }
    if (topLevel === "plugins" && isClaudeMemIdentifier(trimmed.slice(2))) {
      continue;
    }
    if (topLevel === "plugins" && indent === 4 && isClaudeMemIdentifier(key)) {
      skippedIndent = indent;
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

function hasExternalMemoryProvider(config: string): boolean {
  let topLevel = "";
  for (const line of config.split("\n")) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && trimmed.endsWith(":")) {
      topLevel = trimmed.slice(0, -1).replaceAll(/["']/gu, "");
      continue;
    }
    if (topLevel !== "memory" || indent === 0) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).replaceAll(/["']/gu, "");
    if (key !== "provider") continue;
    const value = trimmed
      .slice(separator + 1)
      .split("#", 1)[0]
      ?.trim()
      .replaceAll(/["']/gu, "");
    if (value) return true;
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resetProfileMemory(home: string): Promise<void> {
  const memories = join(home, "memories");
  await mkdir(memories, { recursive: true, mode: 0o700 });
  await Promise.all(
    ["MEMORY.md", "USER.md"].map((name) => writeFile(join(memories, name), "", { mode: 0o600 })),
  );
}

async function atomicWriteFile(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

interface RuntimeSqliteStatement {
  all(...params: string[]): Array<Record<string, unknown>>;
  run(...params: string[]): unknown;
}

interface RuntimeSqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): RuntimeSqliteStatement;
}

async function retainOnlyRuntimeSession(databasePath: string, sessionId: string): Promise<void> {
  const sqliteSpecifier: string = "node:sqlite";
  const sqlite = (await import(sqliteSpecifier)) as unknown as {
    DatabaseSync: new (path: string) => RuntimeSqliteDatabase;
  };
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    if (!tables.has("sessions")) {
      throw new Error("Hermes runtime snapshot has no sessions table");
    }

    database.exec("PRAGMA secure_delete = ON; BEGIN IMMEDIATE");
    if (tables.has("messages")) {
      database.prepare("DELETE FROM messages WHERE session_id <> ?").run(sessionId);
    }
    if (tables.has("session_model_usage")) {
      database.prepare("DELETE FROM session_model_usage WHERE session_id <> ?").run(sessionId);
    }
    if (tables.has("compression_locks")) {
      database.prepare("DELETE FROM compression_locks WHERE session_id <> ?").run(sessionId);
    }
    if (tables.has("async_delegations")) {
      database
        .prepare(
          "DELETE FROM async_delegations " +
            "WHERE origin_session <> ? AND origin_session_id <> ? " +
            "AND COALESCE(parent_session_id, '') <> ?",
        )
        .run(sessionId, sessionId, sessionId);
    }
    if (tables.has("gateway_routing")) {
      database.exec("DELETE FROM gateway_routing");
    }
    database
      .prepare(
        "UPDATE sessions SET parent_session_id = NULL WHERE id = ? AND parent_session_id <> ?",
      )
      .run(sessionId, sessionId);
    database.prepare("DELETE FROM sessions WHERE id <> ?").run(sessionId);
    const retained = database.prepare("SELECT id FROM sessions").all();
    if (retained.length !== 1 || retained[0]?.id !== sessionId) {
      throw new Error(`Hermes runtime snapshot does not contain session '${sessionId}'`);
    }
    if (tables.has("system_prompts")) {
      database.exec(
        "DELETE FROM system_prompts WHERE hash NOT IN " +
          "(SELECT system_prompt_hash FROM sessions WHERE system_prompt_hash IS NOT NULL)",
      );
    }
    database.exec("COMMIT; VACUUM");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may already have committed or failed before beginning.
    }
    throw error;
  } finally {
    database.close();
  }
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_COMMAND_OUTPUT
    ? combined
    : combined.slice(combined.length - MAX_COMMAND_OUTPUT);
}
