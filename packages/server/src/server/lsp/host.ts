import type pino from "pino";
import type { LocationLink, Position } from "vscode-languageserver-protocol";
import {
  descriptorForFile,
  resolveLanguageServer,
  type LanguageServerDescriptor,
} from "./language-servers.js";
import { LspSession } from "./session.js";

/** Idle sessions hold a language server process and its whole project graph in memory. */
const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Paseo hands out a worktree per agent, so the key space is unbounded without a cap. */
const MAX_SESSIONS = 4;
/**
 * Resolving a command costs a `which` spawn plus a `--version` probe, and a miss repeats it on
 * every hover. Remember the answer briefly so installing a server is still picked up without a
 * daemon restart.
 */
const RESOLUTION_TTL_MS = 30_000;

/**
 * A language server being absent is the common case, not a failure: Paseo does not ship
 * binaries. Callers report it to the user instead of surfacing an error.
 */
export type DefinitionOutcome =
  | { status: "ok"; links: LocationLink[] }
  | { status: "unsupported-language" }
  | { status: "server-not-installed"; serverId: string; command: string };

export interface DefinitionInput {
  /** Workspace directory that scopes the language server process. */
  rootPath: string;
  filePath: string;
  /** Identifies the file's content, so an unchanged file is not re-read. */
  version: string;
  readText: () => Promise<string>;
  position: Position;
}

export interface LspHostOptions {
  logger: pino.Logger;
  /**
   * Per-server command overrides keyed by descriptor id, read when a resolution is not cached
   * so a config edit applies without restarting the daemon.
   */
  commandOverrides?: () => Readonly<Record<string, string>>;
}

interface PooledSession {
  session: LspSession;
  idleTimer: NodeJS.Timeout;
}

interface CachedResolution {
  executablePath: string | null;
  /** The command that was probed, so the absent-server report names what to install. */
  command: string;
  expiresAt: number;
}

/**
 * Pools one language server per (workspace root, language). Servers start on first use and are
 * reaped when idle or when the pool overflows, because a loaded project graph is the expensive
 * thing they hold.
 */
export class LspHost {
  private readonly logger: pino.Logger;
  private readonly readCommandOverrides: () => Readonly<Record<string, string>>;
  private readonly sessions = new Map<string, PooledSession>();
  private readonly resolutions = new Map<string, CachedResolution>();
  private disposed = false;

  constructor(options: LspHostOptions) {
    this.logger = options.logger;
    this.readCommandOverrides = options.commandOverrides ?? (() => ({}));
  }

  async definition(input: DefinitionInput): Promise<DefinitionOutcome> {
    const descriptor = descriptorForFile(input.filePath);
    if (!descriptor) {
      return { status: "unsupported-language" };
    }

    const { session, command } = await this.acquireSession(descriptor, input.rootPath);
    if (!session) {
      return { status: "server-not-installed", serverId: descriptor.id, command };
    }

    const links = await session.definition({
      filePath: input.filePath,
      version: input.version,
      readText: input.readText,
      position: input.position,
    });
    return { status: "ok", links };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pooled = [...this.sessions.values()];
    this.sessions.clear();
    this.resolutions.clear();
    await Promise.all(pooled.map((entry) => this.closeEntry(entry)));
  }

  private async acquireSession(
    descriptor: LanguageServerDescriptor,
    rootPath: string,
  ): Promise<{ session: LspSession | null; command: string }> {
    if (this.disposed) {
      throw new Error("language server host is disposed");
    }

    const key = JSON.stringify([rootPath, descriptor.id]);
    const existing = this.sessions.get(key);
    if (existing) {
      this.touch(key, existing);
      return { session: existing.session, command: descriptor.command };
    }

    const { executablePath, command } = await this.resolveExecutable(descriptor);
    if (!executablePath) {
      return { session: null, command };
    }

    // Re-check: resolution awaited, and a concurrent request may have won the race. Without
    // this the loser's process is dropped from the map and never disposed.
    const raced = this.sessions.get(key);
    if (raced) {
      this.touch(key, raced);
      return { session: raced.session, command };
    }

    const session = new LspSession({
      server: { descriptor, executablePath },
      rootPath,
      logger: this.logger,
    });
    this.sessions.set(key, { session, idleTimer: this.scheduleReap(key) });
    this.evictOverflow();
    return { session, command };
  }

  /**
   * Resolution is cached per language rather than per command, so the override lookup — a
   * synchronous `config.json` read and parse on the daemon's event loop — happens at most once
   * per TTL instead of once per hover.
   */
  private async resolveExecutable(descriptor: LanguageServerDescriptor): Promise<CachedResolution> {
    const cached = this.resolutions.get(descriptor.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }
    const command = this.readCommandOverrides()[descriptor.id] ?? descriptor.command;
    const resolved = await resolveLanguageServer(descriptor, command);
    const entry: CachedResolution = {
      executablePath: resolved?.executablePath ?? null,
      command,
      expiresAt: Date.now() + RESOLUTION_TTL_MS,
    };
    this.resolutions.set(descriptor.id, entry);
    return entry;
  }

  /** Oldest insertion first, which for a Map is plain iteration order after touch re-inserts. */
  private evictOverflow(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const [key, entry] = this.sessions.entries().next().value ?? [];
      if (!key || !entry) {
        return;
      }
      this.sessions.delete(key);
      this.logger.debug({ key }, "evicting least recently used language server session");
      void this.closeEntry(entry);
    }
  }

  private touch(key: string, entry: PooledSession): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.scheduleReap(key);
    // Re-insert so Map iteration order tracks recency for eviction.
    this.sessions.delete(key);
    this.sessions.set(key, entry);
  }

  private scheduleReap(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const entry = this.sessions.get(key);
      if (!entry) {
        return;
      }
      this.sessions.delete(key);
      this.logger.debug({ key }, "reaping idle language server session");
      void this.closeEntry(entry);
    }, SESSION_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  private async closeEntry(entry: PooledSession): Promise<void> {
    clearTimeout(entry.idleTimer);
    await entry.session.dispose();
  }
}
