import type { spawn } from "node:child_process";
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
  /** File text as the client rendered it; the position refers to this exact content. */
  text: string;
  position: Position;
}

export interface LspHostOptions {
  logger: pino.Logger;
  /**
   * Per-server command overrides keyed by descriptor id, read on each cold session so a
   * config edit applies without restarting the daemon.
   */
  commandOverrides?: () => Readonly<Record<string, string>>;
  idleTimeoutMs?: number;
  spawnProcess?: typeof spawn;
}

interface PooledSession {
  session: LspSession;
  idleTimer: NodeJS.Timeout;
}

/**
 * Pools one language server per (workspace root, language). Servers start on first use and
 * are reaped when idle, because a loaded project graph is the expensive thing they hold.
 */
export class LspHost {
  private readonly logger: pino.Logger;
  private readonly readCommandOverrides: () => Readonly<Record<string, string>>;
  private readonly idleTimeoutMs: number;
  private readonly spawnProcess: typeof spawn | undefined;
  private readonly sessions = new Map<string, PooledSession>();
  private disposed = false;

  constructor(options: LspHostOptions) {
    this.logger = options.logger;
    this.readCommandOverrides = options.commandOverrides ?? (() => ({}));
    this.idleTimeoutMs = options.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
    this.spawnProcess = options.spawnProcess;
  }

  async definition(input: DefinitionInput): Promise<DefinitionOutcome> {
    const descriptor = descriptorForFile(input.filePath);
    if (!descriptor) {
      return { status: "unsupported-language" };
    }

    const session = await this.acquireSession(descriptor, input.rootPath);
    if (!session) {
      return {
        status: "server-not-installed",
        serverId: descriptor.id,
        command: this.readCommandOverrides()[descriptor.id] ?? descriptor.command,
      };
    }

    const links = await session.definition({
      filePath: input.filePath,
      text: input.text,
      position: input.position,
    });
    return { status: "ok", links };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pooled = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      pooled.map((entry) => {
        clearTimeout(entry.idleTimer);
        return entry.session.dispose();
      }),
    );
  }

  private async acquireSession(
    descriptor: LanguageServerDescriptor,
    rootPath: string,
  ): Promise<LspSession | null> {
    if (this.disposed) {
      throw new Error("language server host is disposed");
    }

    const key = JSON.stringify([rootPath, descriptor.id]);
    const existing = this.sessions.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing.session;
    }

    const server = await resolveLanguageServer(
      descriptor,
      this.readCommandOverrides()[descriptor.id],
    );
    if (!server) {
      return null;
    }

    const session = new LspSession({
      server,
      rootPath,
      logger: this.logger,
      spawnProcess: this.spawnProcess,
    });
    const entry: PooledSession = { session, idleTimer: this.scheduleReap(key) };
    this.sessions.set(key, entry);
    return session;
  }

  private touch(key: string, entry: PooledSession): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.scheduleReap(key);
  }

  private scheduleReap(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const entry = this.sessions.get(key);
      if (!entry) {
        return;
      }
      this.sessions.delete(key);
      this.logger.debug({ key }, "reaping idle language server session");
      void entry.session.dispose();
    }, this.idleTimeoutMs);
    timer.unref?.();
    return timer;
  }
}
