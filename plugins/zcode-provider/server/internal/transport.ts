import type { ZCodeSessionSettings } from "./catalog.js";
import type { ZCodeRequestFrame } from "./wire.js";

export type { ZCodeRequestFrame } from "./wire.js";

export interface ZCodeWorkspaceRef {
  workspacePath: string;
  workspaceKey: string;
}

export interface ZCodeSessionHandle {
  sessionId: string;
  workspace: ZCodeWorkspaceRef;
}

export interface ZCodeTransport {
  readonly capabilities: readonly string[];
  /** The ZCode methods this app-server does not implement. */
  readonly unavailableMethods: ReadonlySet<string>;
  createSession(input: {
    workspace: ZCodeWorkspaceRef;
    mode?: string;
    model?: string;
    thoughtLevel?: string;
  }): Promise<ZCodeSessionHandle>;
  resumeSession(input: {
    sessionId: string;
    workspace?: ZCodeWorkspaceRef;
  }): Promise<ZCodeSessionHandle>;
  send(input: { sessionId: string; content: string; inputId: string }): Promise<void>;
  stop(input: { sessionId: string }): Promise<void>;
  /** Closes the ZCode session without ending the app-server process. */
  archive(input: { sessionId: string }): Promise<void>;
  /**
   * ZCode asks the host for permission with a reverse request and waits for
   * the answer, so the host has to answer requests as well as make them.
   */
  onRequest(listener: (request: ZCodeRequestFrame) => Promise<unknown> | unknown): () => void;
  /**
   * Reads a session snapshot. ZCode returns its model, mode and thought-level
   * options on the snapshot, so the catalog is read through a session.
   */
  readSnapshot(input: { sessionId: string }): Promise<{ settings?: ZCodeSessionSettings }>;
  listSessions(input: { workspace?: ZCodeWorkspaceRef; limit?: number }): Promise<unknown[]>;
  setModel(input: { sessionId: string; model: string }): Promise<void>;
  setMode(input: { sessionId: string; mode: string }): Promise<void>;
  setThoughtLevel(input: { sessionId: string; thoughtLevel: string }): Promise<void>;
  onEvent(listener: (event: ZCodeEvent) => void): () => void;
  close(): Promise<void>;
}

export interface ZCodeEvent {
  type: string;
  sessionId: string;
  turnId?: string;
  seq: number;
  payload: unknown;
}
