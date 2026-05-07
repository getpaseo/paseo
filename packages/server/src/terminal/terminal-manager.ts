import { createTerminal, type TerminalSession, type TerminalStateSnapshot } from "./terminal.js";
import { captureTerminalLines, type CaptureTerminalLinesResult } from "./terminal-capture.js";
import { resolve, sep, win32, posix } from "node:path";

export interface TerminalListItem {
  id: string;
  name: string;
  cwd: string;
  title?: string;
}

export interface TerminalsChangedEvent {
  cwd: string;
  terminals: TerminalListItem[];
}

export type TerminalsChangedListener = (input: TerminalsChangedEvent) => void;

export interface TerminalManager {
  getTerminals(cwd: string): Promise<TerminalSession[]>;
  createTerminal(options: {
    id?: string;
    cwd: string;
    name?: string;
    title?: string;
    env?: Record<string, string>;
    command?: string;
    args?: string[];
  }): Promise<TerminalSession>;
  registerCwdEnv(options: { cwd: string; env: Record<string, string> }): void;
  getTerminal(id: string): TerminalSession | undefined;
  getTerminalState(id: string): Promise<TerminalStateSnapshot | null>;
  killTerminal(id: string): void;
  killTerminalAndWait(
    id: string,
    options?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number },
  ): Promise<void>;
  captureTerminal(
    id: string,
    options?: { start?: number; end?: number; stripAnsi?: boolean },
  ): Promise<CaptureTerminalLinesResult>;
  listDirectories(): string[];
  killAll(): void;
  subscribeTerminalsChanged(listener: TerminalsChangedListener): () => void;
}

export function createTerminalManager(): TerminalManager {
  const terminalsByCwd = new Map<string, TerminalSession[]>();
  const terminalsById = new Map<string, TerminalSession>();
  const terminalExitUnsubscribeById = new Map<string, () => void>();
  const terminalTitleUnsubscribeById = new Map<string, () => void>();
  const terminalsChangedListeners = new Set<TerminalsChangedListener>();
  const defaultEnvByRootCwd = new Map<string, Record<string, string>>();

  function assertAbsolutePath(cwd: string): void {
    if (!posix.isAbsolute(cwd) && !win32.isAbsolute(cwd)) {
      throw new Error("cwd must be absolute path");
    }
  }

  function removeSessionById(id: string, options: { kill: boolean }): void {
    const session = terminalsById.get(id);
    if (!session) {
      return;
    }

    const unsubscribeExit = terminalExitUnsubscribeById.get(id);
    if (unsubscribeExit) {
      unsubscribeExit();
      terminalExitUnsubscribeById.delete(id);
    }
    const unsubscribeTitle = terminalTitleUnsubscribeById.get(id);
    if (unsubscribeTitle) {
      unsubscribeTitle();
      terminalTitleUnsubscribeById.delete(id);
    }

    terminalsById.delete(id);

    const terminals = terminalsByCwd.get(session.cwd);
    if (terminals) {
      const index = terminals.findIndex((terminal) => terminal.id === id);
      if (index !== -1) {
        terminals.splice(index, 1);
      }
      if (terminals.length === 0) {
        terminalsByCwd.delete(session.cwd);
      }
    }

    if (options.kill) {
      session.kill();
    }

    emitTerminalsChanged({ cwd: session.cwd });
  }

  function resolveDefaultEnvForCwd(cwd: string): Record<string, string> | undefined {
    const normalizedCwd = resolve(cwd);
    let bestMatchRoot: string | null = null;

    for (const rootCwd of defaultEnvByRootCwd.keys()) {
      const matches = normalizedCwd === rootCwd || normalizedCwd.startsWith(`${rootCwd}${sep}`);
      if (!matches) {
        continue;
      }
      if (!bestMatchRoot || rootCwd.length > bestMatchRoot.length) {
        bestMatchRoot = rootCwd;
      }
    }

    return bestMatchRoot ? defaultEnvByRootCwd.get(bestMatchRoot) : undefined;
  }

  function registerSession(session: TerminalSession): TerminalSession {
    terminalsById.set(session.id, session);
    const unsubscribeExit = session.onExit(() => {
      removeSessionById(session.id, { kill: false });
    });
    const unsubscribeTitle = session.onTitleChange(() => {
      emitTerminalsChanged({ cwd: session.cwd });
    });
    terminalExitUnsubscribeById.set(session.id, unsubscribeExit);
    terminalTitleUnsubscribeById.set(session.id, unsubscribeTitle);
    return session;
  }

  function toTerminalListItem(input: { session: TerminalSession }): TerminalListItem {
    return {
      id: input.session.id,
      name: input.session.name,
      cwd: input.session.cwd,
      title: input.session.getTitle(),
    };
  }

  function emitTerminalsChanged(input: { cwd: string }): void {
    if (terminalsChangedListeners.size === 0) {
      return;
    }

    const terminals = (terminalsByCwd.get(input.cwd) ?? []).map((session) =>
      toTerminalListItem({ session }),
    );
    const event: TerminalsChangedEvent = {
      cwd: input.cwd,
      terminals,
    };

    for (const listener of terminalsChangedListeners) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }

  return {
    async getTerminals(cwd: string): Promise<TerminalSession[]> {
      assertAbsolutePath(cwd);

      return terminalsByCwd.get(cwd) ?? [];
    },

    async createTerminal(options: {
      id?: string;
      cwd: string;
      name?: string;
      title?: string;
      env?: Record<string, string>;
      command?: string;
      args?: string[];
    }): Promise<TerminalSession> {
      assertAbsolutePath(options.cwd);

      const terminals = terminalsByCwd.get(options.cwd) ?? [];
      const defaultName = `Terminal ${terminals.length + 1}`;
      const inheritedEnv = resolveDefaultEnvForCwd(options.cwd);
      const mergedEnv =
        inheritedEnv || options.env ? { ...inheritedEnv, ...options.env } : undefined;
      const session = registerSession(
        await createTerminal({
          ...(options.id ? { id: options.id } : {}),
          cwd: options.cwd,
          name: options.name ?? defaultName,
          ...(options.title ? { title: options.title } : {}),
          ...(options.command ? { command: options.command } : {}),
          ...(options.args ? { args: options.args } : {}),
          ...(mergedEnv ? { env: mergedEnv } : {}),
        }),
      );

      terminals.push(session);
      terminalsByCwd.set(options.cwd, terminals);
      emitTerminalsChanged({ cwd: options.cwd });

      return session;
    },

    registerCwdEnv(options: { cwd: string; env: Record<string, string> }): void {
      assertAbsolutePath(options.cwd);
      defaultEnvByRootCwd.set(resolve(options.cwd), { ...options.env });
    },

    getTerminal(id: string): TerminalSession | undefined {
      return terminalsById.get(id);
    },

    async getTerminalState(id: string): Promise<TerminalStateSnapshot | null> {
      return terminalsById.get(id)?.getStateSnapshot() ?? null;
    },

    killTerminal(id: string): void {
      removeSessionById(id, { kill: true });
    },

    async killTerminalAndWait(
      id: string,
      options?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number },
    ): Promise<void> {
      const session = terminalsById.get(id);
      if (!session) {
        return;
      }
      try {
        await session.killAndWait(options);
      } finally {
        removeSessionById(id, { kill: false });
      }
    },

    async captureTerminal(
      id: string,
      options?: { start?: number; end?: number; stripAnsi?: boolean },
    ): Promise<CaptureTerminalLinesResult> {
      const session = terminalsById.get(id);
      if (!session) {
        return {
          lines: [],
          totalLines: 0,
        };
      }
      return captureTerminalLines(session, options);
    },

    listDirectories(): string[] {
      return Array.from(terminalsByCwd.keys());
    },

    killAll(): void {
      for (const id of Array.from(terminalsById.keys())) {
        removeSessionById(id, { kill: true });
      }
    },

    subscribeTerminalsChanged(listener: TerminalsChangedListener): () => void {
      terminalsChangedListeners.add(listener);
      return () => {
        terminalsChangedListeners.delete(listener);
      };
    },
  };
}
