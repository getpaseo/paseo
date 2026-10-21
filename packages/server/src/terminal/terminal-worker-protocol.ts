import type {
  TerminalExitInfo,
  ServerMessage,
  ClientMessage,
  TerminalStateSnapshot,
  TerminalStateSnapshotOptions,
} from "./terminal.js";
import type { TerminalState } from "@getpaseo/protocol/messages";
import type { TerminalActivity, TerminalActivityState } from "@getpaseo/protocol/terminal-activity";
import type { CaptureTerminalLinesResult } from "./terminal-capture.js";

export interface WorkerTerminalInfo {
  id: string;
  name: string;
  cwd: string;
  workspaceId?: string;
  title?: string;
  activity: TerminalActivity | null;
}

export interface WorkerCreateTerminalOptions {
  id?: string;
  cwd: string;
  workspaceId?: string;
  name?: string;
  title?: string;
  env?: Record<string, string>;
  command?: string;
  args?: string[];
  rows?: number;
  cols?: number;
  activityToken?: string;
  activityUrl?: string | null;
  // The worker outlives the daemon that started it, so the controlling daemon
  // sends its own environment and Paseo CLI path with every create instead of
  // letting the worker reuse whatever it inherited at launch.
  baseEnv?: Record<string, string>;
  paseoCliPath?: string | null;
}

// Bumped when a request, response or event changes shape. Milestone 2 adds
// the version handshake semantics; the record and hello carry it from day one.
export const TERMINAL_WORKER_PROTOCOL_VERSION = 1;

export interface TerminalWorkerHello {
  type: "hello";
  secret: string;
  protocolVersion: number;
}

export interface TerminalWorkerHelloAck {
  type: "helloAck";
  pid: number;
  protocolVersion: number;
}

export interface WorkerListedTerminal {
  terminal: WorkerTerminalInfo;
  state: TerminalState;
  activityToken: string | null;
  replayPreamble: string;
}

export interface WorkerKillAndWaitOptions {
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
}

export type TerminalWorkerRequest =
  | {
      type: "createTerminal";
      requestId: string;
      options: WorkerCreateTerminalOptions;
    }
  | {
      type: "registerCwdEnv";
      requestId: string;
      cwd: string;
      env: Record<string, string>;
    }
  | {
      type: "setActivity";
      requestId: string;
      terminalId: string;
      state: TerminalActivityState;
    }
  | {
      type: "clearAttention";
      requestId: string;
      terminalId: string;
    }
  | {
      type: "killTerminal";
      requestId: string;
      terminalId: string;
    }
  | {
      type: "killTerminalAndWait";
      requestId: string;
      terminalId: string;
      options?: WorkerKillAndWaitOptions;
    }
  | {
      type: "getTerminalState";
      requestId: string;
      terminalId: string;
      options?: TerminalStateSnapshotOptions;
    }
  | {
      type: "captureTerminal";
      requestId: string;
      terminalId: string;
      start?: number;
      end?: number;
      stripAnsi?: boolean;
    }
  | {
      type: "listTerminals";
      requestId: string;
    }
  | {
      // Kill every terminal (waiting for each program to exit) and exit.
      type: "shutdown";
      requestId: string;
    }
  | {
      type: "send";
      requestId: string;
      terminalId: string;
      message: ClientMessage;
    };

export type TerminalWorkerResponse =
  | {
      type: "response";
      requestId: string;
      ok: true;
      result?: unknown;
    }
  | {
      type: "response";
      requestId: string;
      ok: false;
      error: string;
    };

export type TerminalWorkerEvent =
  | {
      type: "terminalCreated";
      terminal: WorkerTerminalInfo;
      state: TerminalState;
    }
  | {
      type: "terminalMessage";
      terminalId: string;
      message: ServerMessage;
    }
  | {
      type: "terminalExit";
      terminalId: string;
      info: TerminalExitInfo;
    }
  | {
      type: "terminalTitleChange";
      terminalId: string;
      title?: string;
    }
  | {
      type: "terminalCommandFinished";
      terminalId: string;
      info: {
        exitCode: number | null;
      };
    }
  | {
      type: "terminalActivityChange";
      terminalId: string;
      activity: TerminalActivity | null;
      previous: TerminalActivity | null;
    };

export type TerminalWorkerToParentMessage = TerminalWorkerResponse | TerminalWorkerEvent;

export type TerminalWorkerListResult = WorkerListedTerminal[];

export type TerminalWorkerCaptureResult = CaptureTerminalLinesResult;
// The worker fills TerminalStateSnapshot.replayPreamble on getTerminalState so
// the parent can cache the input-mode preamble instead of re-deriving it.
export type TerminalWorkerStateResult = TerminalStateSnapshot | null;
