import { stat } from "node:fs/promises";
import type { Logger } from "pino";
import { isSameOrDescendantPath } from "../server/path-utils.js";
import type { TerminalManager } from "./terminal-manager.js";
import type { TerminalSession } from "./terminal.js";
import type {
  PersistedTerminal,
  PersistedTerminalAgentSession,
  PersistedTerminalStore,
} from "./persisted-terminal-store.js";
import { planTerminalRelaunch, SAFE_AGENT_SESSION_ID } from "./terminal-relaunch.js";

export interface TerminalAgentSessionReport {
  provider: string;
  // `null` when the agent session ended.
  sessionId: string | null;
  cwd?: string;
}

export interface TerminalPersistenceOptions {
  manager: TerminalManager;
  store: PersistedTerminalStore;
  isEnabled: () => boolean;
  logger: Logger;
  now?: () => Date;
  restoreConcurrency?: number;
}

export interface TerminalRestoreSummary {
  restored: string[];
  dropped: string[];
}

export interface TerminalPersistence {
  // Use in place of the wrapped manager. Terminals created with `restorable: true`
  // are recorded; closing or exiting them deletes the record. Daemon shutdown
  // keeps it.
  manager: TerminalManager;
  recordAgentSession(terminalId: string, report: TerminalAgentSessionReport): void;
  setEnabled(enabled: boolean): Promise<void>;
  restore(options: {
    canRestore: (record: PersistedTerminal) => Promise<boolean>;
  }): Promise<TerminalRestoreSummary>;
  // Freeze records before the daemon tears anything down. Agents see SIGHUP once
  // their terminal dies and may report the session as ended, or the terminal may
  // exit; neither must erase what the next start restores.
  prepareForShutdown(): void;
  flush(): Promise<void>;
}

const DEFAULT_RESTORE_CONCURRENCY = 4;

interface TrackedTerminal {
  record: PersistedTerminal;
  unsubscribe: () => void;
}

export function createTerminalPersistence(
  options: TerminalPersistenceOptions,
): TerminalPersistence {
  const { manager: inner, store, isEnabled, logger } = options;
  const now = options.now ?? (() => new Date());
  const tracked = new Map<string, TrackedTerminal>();
  const pendingWrites = new Set<Promise<void>>();
  let toggleChain: Promise<void> = Promise.resolve();
  let shuttingDown = false;

  function track(session: TerminalSession, record: PersistedTerminal): void {
    const unsubscribeExit = session.onExit(() => forget(record.id));
    // The shell reports a finished foreground command once the agent quits back
    // to it. That clears the session for every provider, including Codex, which
    // has no session-end hook.
    const unsubscribeCommand = session.onCommandFinished(() => setAgentSession(record.id, null));
    tracked.set(record.id, {
      record,
      unsubscribe: () => {
        unsubscribeExit();
        unsubscribeCommand();
      },
    });
    write(record);
  }

  function forget(id: string): void {
    const entry = tracked.get(id);
    if (shuttingDown || !entry) return;
    tracked.delete(id);
    entry.unsubscribe();
    if (isEnabled()) {
      enqueue(() => store.delete(id), id);
    }
  }

  function setAgentSession(id: string, agentSession: PersistedTerminalAgentSession | null): void {
    const entry = tracked.get(id);
    if (shuttingDown || !entry) return;
    if (sameAgentSession(entry.record.agentSession, agentSession)) return;
    const { agentSession: _previous, ...rest } = entry.record;
    entry.record = {
      ...rest,
      ...(agentSession ? { agentSession } : {}),
      updatedAt: now().toISOString(),
    };
    write(entry.record);
  }

  function write(record: PersistedTerminal): void {
    if (!isEnabled()) return;
    enqueue(() => store.put(record), record.id);
  }

  function enqueue(operation: () => Promise<void>, terminalId?: string): Promise<void> {
    const pending = operation().catch((error: unknown) => {
      logger.warn({ err: error, terminalId }, "Failed to persist terminal record");
    });
    pendingWrites.add(pending);
    void pending.finally(() => pendingWrites.delete(pending));
    return pending;
  }

  async function restoreOne(record: PersistedTerminal): Promise<boolean> {
    const plan = planTerminalRelaunch(record);
    const session = await inner.createTerminal({
      id: record.id,
      // A relaunched command replays its original flags, and relative paths in
      // them (`codex -C packages/app`) resolve against the original launch cwd.
      cwd: plan.kind === "command" ? record.cwd : await resumeCwd(record),
      workspaceId: record.workspaceId,
      name: record.name,
      ...(plan.kind === "command" && plan.command ? { command: plan.command } : {}),
      ...(plan.kind === "command" && plan.args ? { args: plan.args } : {}),
    });
    if (plan.kind === "shell-input") {
      session.send({ type: "input", data: plan.input });
    }
    // The record keeps the original launch; the resume command is derived
    // again on every restore from the latest agent session.
    track(session, { ...record, updatedAt: now().toISOString() });
    return true;
  }

  const manager: TerminalManager = {
    ...inner,
    async createTerminal(createOptions) {
      const { restorable, ...rest } = createOptions;
      const session = await inner.createTerminal(rest);
      if (restorable) {
        const timestamp = now().toISOString();
        track(session, {
          id: session.id,
          workspaceId: session.workspaceId,
          cwd: session.cwd,
          name: session.name,
          ...(rest.command ? { command: rest.command } : {}),
          ...(rest.args ? { args: rest.args } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      return session;
    },
    killTerminal(id) {
      inner.killTerminal(id);
      forget(id);
    },
    async killTerminalAndWait(id, killOptions) {
      try {
        await inner.killTerminalAndWait(id, killOptions);
      } finally {
        forget(id);
      }
    },
    killAll() {
      shuttingDown = true;
      inner.killAll();
    },
  };

  return {
    manager,

    recordAgentSession(terminalId, report) {
      const agentSession = toAgentSession(report);
      if (agentSession === undefined) return;
      setAgentSession(terminalId, agentSession);
    },

    setEnabled(enabled) {
      // Serialized so a fast off→on toggle cannot clear records written by the on.
      toggleChain = toggleChain.then(() =>
        enqueue(async () => {
          if (!enabled) {
            await store.clear();
            return;
          }
          await Promise.all(Array.from(tracked.values(), (entry) => store.put(entry.record)));
        }),
      );
      return toggleChain;
    },

    async restore({ canRestore }) {
      const summary: TerminalRestoreSummary = { restored: [], dropped: [] };
      if (!isEnabled()) {
        // Records written while the setting was on would resurrect old terminals
        // the next time it is turned on.
        await store.clear();
        return summary;
      }
      const queue = await store.list();
      const concurrency = options.restoreConcurrency ?? DEFAULT_RESTORE_CONCURRENCY;
      async function drain(): Promise<void> {
        for (let record = queue.shift(); record; record = queue.shift()) {
          const restored = await tryRestore(record);
          (restored ? summary.restored : summary.dropped).push(record.id);
          if (!restored) await store.delete(record.id);
        }
      }
      async function tryRestore(record: PersistedTerminal): Promise<boolean> {
        if (!(await canRestore(record))) return false;
        try {
          return await restoreOne(record);
        } catch (error) {
          logger.warn({ err: error, terminalId: record.id }, "Failed to restore terminal");
          return false;
        }
      }
      await Promise.all(Array.from({ length: concurrency }, drain));
      return summary;
    },

    prepareForShutdown() {
      shuttingDown = true;
    },

    async flush() {
      await Promise.all(pendingWrites);
    },
  };
}

// An agent typed into a shell resumes where it reported its session, as long as
// that directory still exists inside the terminal's cwd; the restored tab must
// stay in its workspace.
async function resumeCwd(record: PersistedTerminal): Promise<string> {
  const sessionCwd = record.agentSession?.cwd;
  if (!sessionCwd || !isSameOrDescendantPath(record.cwd, sessionCwd)) return record.cwd;
  const isDirectory = (await stat(sessionCwd).catch(() => null))?.isDirectory() ?? false;
  return isDirectory ? sessionCwd : record.cwd;
}

// Validated here rather than at the route so a junk session id still lets the
// hook report activity, but never reaches disk.
function toAgentSession(
  report: TerminalAgentSessionReport,
): PersistedTerminalAgentSession | null | undefined {
  if (report.sessionId === null) return null;
  if (report.provider !== "claude" && report.provider !== "codex") return undefined;
  if (!SAFE_AGENT_SESSION_ID.test(report.sessionId)) return undefined;
  return {
    provider: report.provider,
    sessionId: report.sessionId,
    ...(report.cwd ? { cwd: report.cwd } : {}),
  };
}

function sameAgentSession(
  left: PersistedTerminalAgentSession | undefined,
  right: PersistedTerminalAgentSession | null,
): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.provider === right.provider && left.sessionId === right.sessionId && left.cwd === right.cwd
  );
}
