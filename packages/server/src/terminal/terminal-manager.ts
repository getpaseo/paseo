import {
  createTerminal,
  type TerminalActivityTransition,
  type TerminalSession,
  type TerminalStateSnapshot,
  type TerminalStateSnapshotOptions,
} from "./terminal.js";
import { captureTerminalLines, type CaptureTerminalLinesResult } from "./terminal-capture.js";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { assertAbsolutePath, isSameOrDescendantPath } from "../server/path-utils.js";
import type { TerminalActivity, TerminalActivityState } from "@getpaseo/protocol/terminal-activity";

export interface TerminalListItem {
  id: string;
  name: string;
  cwd: string;
  workspaceId?: string;
  title?: string;
  activity: TerminalActivity | null;
}

export interface TerminalsChangedEvent {
  cwd: string;
  terminals: TerminalListItem[];
}

export type TerminalsChangedListener = (input: TerminalsChangedEvent) => void;

export interface TerminalActivityTransitionEvent {
  terminalId: string;
  name: string;
  cwd: string;
  activity: TerminalActivity | null;
  previous: TerminalActivity | null;
}

export type TerminalActivityListener = (event: TerminalActivityTransitionEvent) => void;

export interface TerminalManager {
  getTerminals(cwd: string, options?: { workspaceId?: string }): Promise<TerminalSession[]>;
  createTerminal(options: {
    id?: string;
    cwd: string;
    workspaceId?: string;
    name?: string;
    title?: string;
    env?: Record<string, string>;
    command?: string;
    args?: string[];
    activityToken?: string;
    activityUrl?: string | null;
  }): Promise<TerminalSession>;
  registerCwdEnv(options: { cwd: string; env: Record<string, string> }): void;
  validateTerminalActivityToken(terminalId: string, token: string): "valid" | "unknown" | "invalid";
  getTerminal(id: string): TerminalSession | undefined;
  getTerminalState(
    id: string,
    options?: TerminalStateSnapshotOptions,
  ): Promise<TerminalStateSnapshot | null>;
  setTerminalTitle(id: string, title: string): boolean;
  setTerminalActivity(id: string, state: TerminalActivityState): Promise<boolean>;
  clearTerminalAttention(id: string): Promise<boolean>;
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
  subscribeTerminalActivity(listener: TerminalActivityListener): () => void;
}

export interface TerminalManagerOptions {
  getTerminalActivityUrl?: () => string | null;
}

function createActivityToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createTerminalManager(
  managerOptions: TerminalManagerOptions = {},
): TerminalManager {
  const terminalsByCwd = new Map<string, TerminalSession[]>();
  const terminalsById = new Map<string, TerminalSession>();
  const terminalExitUnsubscribeById = new Map<string, () => void>();
  const terminalTitleUnsubscribeById = new Map<string, () => void>();
  const terminalActivityUnsubscribeById = new Map<string, () => void>();
  const terminalActivityTokenById = new Map<string, string>();
  const terminalsChangedListeners = new Set<TerminalsChangedListener>();
  const terminalActivityListeners = new Set<TerminalActivityListener>();
  const defaultEnvByRootCwd = new Map<string, Record<string, string>>();

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
    const unsubscribeActivity = terminalActivityUnsubscribeById.get(id);
    if (unsubscribeActivity) {
      unsubscribeActivity();
      terminalActivityUnsubscribeById.delete(id);
    }

    terminalsById.delete(id);
    terminalActivityTokenById.delete(id);

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
    const unsubscribeActivity = session.onActivityChange((transition) => {
      emitTerminalActivityTransition({ session, transition });
      emitTerminalsChanged({ cwd: session.cwd });
    });
    terminalExitUnsubscribeById.set(session.id, unsubscribeExit);
    terminalTitleUnsubscribeById.set(session.id, unsubscribeTitle);
    terminalActivityUnsubscribeById.set(session.id, unsubscribeActivity);
    return session;
  }

  function toTerminalListItem(input: { session: TerminalSession }): TerminalListItem {
    return {
      id: input.session.id,
      name: input.session.name,
      cwd: input.session.cwd,
      ...(input.session.workspaceId ? { workspaceId: input.session.workspaceId } : {}),
      title: input.session.getTitle(),
      activity: input.session.getActivity(),
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

  function emitTerminalActivityTransition(input: {
    session: TerminalSession;
    transition: TerminalActivityTransition;
  }): void {
    if (terminalActivityListeners.size === 0) {
      return;
    }
    const event: TerminalActivityTransitionEvent = {
      terminalId: input.session.id,
      name: input.session.name,
      cwd: input.session.cwd,
      activity: input.transition.activity,
      previous: input.transition.previous,
    };
    for (const listener of terminalActivityListeners) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }

  return {
    async getTerminals(
      cwd: string,
      options?: { workspaceId?: string },
    ): Promise<TerminalSession[]> {
      assertAbsolutePath(cwd);

      // Terminals are bucketed by exact cwd, but an agent can open a terminal in
      // a subdirectory of the workspace. A query for the workspace root must
      // surface those too, so aggregate every bucket at or below `cwd`.
      const sessions: TerminalSession[] = [];
      for (const [bucketCwd, bucketSessions] of terminalsByCwd) {
        if (isSameOrDescendantPath(cwd, bucketCwd)) {
          sessions.push(...bucketSessions);
        }
      }

      // When the query carries a workspaceId, two workspaces sharing a cwd must
      // not see each other's terminals. Exclude sessions owned by a different
      // workspace; keep sessions without an owner (COMPAT: created by clients
      // that predate terminal workspace ownership).
      if (options?.workspaceId !== undefined) {
        return sessions.filter(
          (session) =>
            session.workspaceId === undefined || session.workspaceId === options.workspaceId,
        );
      }
      return sessions;
    },

    async createTerminal(options: {
      id?: string;
      cwd: string;
      workspaceId?: string;
      name?: string;
      title?: string;
      env?: Record<string, string>;
      command?: string;
      args?: string[];
      activityToken?: string;
      activityUrl?: string | null;
    }): Promise<TerminalSession> {
      assertAbsolutePath(options.cwd);

      const terminals = terminalsByCwd.get(options.cwd) ?? [];
      const defaultName = `Terminal ${terminals.length + 1}`;
      const inheritedEnv = resolveDefaultEnvForCwd(options.cwd);
      const mergedEnv =
        inheritedEnv || options.env ? { ...inheritedEnv, ...options.env } : undefined;
      const terminalId = options.id ?? randomUUID();
      const activityToken = options.activityToken ?? createActivityToken();
      const terminalActivityUrl =
        options.activityUrl === undefined
          ? (managerOptions.getTerminalActivityUrl?.() ?? null)
          : options.activityUrl;
      const activityEnv = {
        PASEO_TERMINAL_ID: terminalId,
        PASEO_ACTIVITY_TOKEN: activityToken,
        ...(terminalActivityUrl ? { PASEO_TERMINAL_ACTIVITY_URL: terminalActivityUrl } : {}),
      };
      terminalActivityTokenById.set(terminalId, activityToken);
      let session: TerminalSession;
      try {
        session = registerSession(
          await createTerminal({
            id: terminalId,
            cwd: options.cwd,
            ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
            name: options.name ?? defaultName,
            ...(options.title ? { title: options.title } : {}),
            ...(options.command ? { command: options.command } : {}),
            ...(options.args ? { args: options.args } : {}),
            ...(mergedEnv ? { env: mergedEnv } : {}),
            activityEnv,
          }),
        );
      } catch (error) {
        terminalActivityTokenById.delete(terminalId);
        throw error;
      }

      terminals.push(session);
      terminalsByCwd.set(options.cwd, terminals);
      emitTerminalsChanged({ cwd: options.cwd });

      return session;
    },

    registerCwdEnv(options: { cwd: string; env: Record<string, string> }): void {
      assertAbsolutePath(options.cwd);
      defaultEnvByRootCwd.set(resolve(options.cwd), { ...options.env });
    },

    validateTerminalActivityToken(
      terminalId: string,
      token: string,
    ): "valid" | "unknown" | "invalid" {
      const expected = terminalActivityTokenById.get(terminalId);
      if (!expected) {
        return "unknown";
      }
      return expected === token ? "valid" : "invalid";
    },

    getTerminal(id: string): TerminalSession | undefined {
      return terminalsById.get(id);
    },

    async getTerminalState(
      id: string,
      options?: TerminalStateSnapshotOptions,
    ): Promise<TerminalStateSnapshot | null> {
      return terminalsById.get(id)?.getStateSnapshot(options) ?? null;
    },

    setTerminalTitle(id: string, title: string): boolean {
      const session = terminalsById.get(id);
      if (!session) {
        return false;
      }

      session.setTitle(title);
      return true;
    },

    async setTerminalActivity(id: string, state: TerminalActivityState): Promise<boolean> {
      const session = terminalsById.get(id);
      if (!session) {
        return false;
      }

      session.setActivity(state);
      return true;
    },

    async clearTerminalAttention(id: string): Promise<boolean> {
      const session = terminalsById.get(id);
      if (!session) {
        return false;
      }

      return session.clearActivityAttention();
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

    subscribeTerminalActivity(listener: TerminalActivityListener): () => void {
      terminalActivityListeners.add(listener);
      return () => {
        terminalActivityListeners.delete(listener);
      };
    },
  };
}
