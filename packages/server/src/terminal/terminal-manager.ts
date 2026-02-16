import { createTerminal, type TerminalSession } from "./terminal.js";
import { resolve, sep } from "node:path";

export interface TerminalListItem {
  id: string;
  name: string;
  cwd: string;
}

export interface TerminalsChangedEvent {
  cwd: string;
  terminals: TerminalListItem[];
}

export type TerminalsChangedListener = (input: TerminalsChangedEvent) => void;

export interface TerminalManager {
  getTerminals(cwd: string): Promise<TerminalSession[]>;
  createTerminal(options: {
    cwd: string;
    name?: string;
    env?: Record<string, string>;
  }): Promise<TerminalSession>;
  registerCwdEnv(options: { cwd: string; env: Record<string, string> }): void;
  getTerminal(id: string): TerminalSession | undefined;
  killTerminal(id: string): void;
  listDirectories(): string[];
  killAll(): void;
  subscribeTerminalsChanged(listener: TerminalsChangedListener): () => void;
}

export function createTerminalManager(): TerminalManager {
  const terminalsByCwd = new Map<string, TerminalSession[]>();
  const terminalsById = new Map<string, TerminalSession>();
  const terminalExitUnsubscribeById = new Map<string, () => void>();
  const terminalsChangedListeners = new Set<TerminalsChangedListener>();
  const defaultEnvByRootCwd = new Map<string, Record<string, string>>();

  function assertAbsolutePath(cwd: string): void {
    if (!cwd.startsWith("/")) {
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
    terminalExitUnsubscribeById.set(session.id, unsubscribeExit);
    return session;
  }

  function toTerminalListItem(input: { session: TerminalSession }): TerminalListItem {
    return {
      id: input.session.id,
      name: input.session.name,
      cwd: input.session.cwd,
    };
  }

  function emitTerminalsChanged(input: { cwd: string }): void {
    if (terminalsChangedListeners.size === 0) {
      return;
    }

    const terminals = (terminalsByCwd.get(input.cwd) ?? []).map((session) =>
      toTerminalListItem({ session })
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

      let terminals = terminalsByCwd.get(cwd);
      if (!terminals || terminals.length === 0) {
        const inheritedEnv = resolveDefaultEnvForCwd(cwd);
        const session = registerSession(
          await createTerminal({
            cwd,
            name: "Terminal 1",
            ...(inheritedEnv ? { env: inheritedEnv } : {}),
          })
        );
        terminals = [session];
        terminalsByCwd.set(cwd, terminals);
        emitTerminalsChanged({ cwd });
      }
      return terminals;
    },

    async createTerminal(options: {
      cwd: string;
      name?: string;
      env?: Record<string, string>;
    }): Promise<TerminalSession> {
      assertAbsolutePath(options.cwd);

      const terminals = terminalsByCwd.get(options.cwd) ?? [];
      const defaultName = `Terminal ${terminals.length + 1}`;
      const inheritedEnv = resolveDefaultEnvForCwd(options.cwd);
      const mergedEnv =
        inheritedEnv || options.env
          ? { ...(inheritedEnv ?? {}), ...(options.env ?? {}) }
          : undefined;
      const session = registerSession(
        await createTerminal({
          cwd: options.cwd,
          name: options.name ?? defaultName,
          ...(mergedEnv ? { env: mergedEnv } : {}),
        })
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

    killTerminal(id: string): void {
      removeSessionById(id, { kill: true });
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
