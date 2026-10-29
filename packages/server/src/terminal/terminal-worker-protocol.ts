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

// Bumped when a request, response or event changes shape. The frozen envelope never changes
// across versions: the frame format, `hello`/`helloAck`, the `listTerminals` info fields, and
// `shutdown`. A daemon drives a worker of its own version, drains one a version older (no new
// terminals; it exits after its last terminal), shuts down anything older, and leaves a newer
// worker running untouched. See docs/terminal-worker.md.
export const TERMINAL_WORKER_PROTOCOL_VERSION = 1;

// Test-only: the protocol version a worker reports, so tests can stand up older and newer
// workers from one build.
export const TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV = "PASEO_TERMINAL_WORKER_PROTOCOL_OVERRIDE";

/** How a daemon at `current` treats a worker reporting `reported`. */
export type TerminalWorkerProtocolFit = "current" | "previous" | "obsolete" | "newer";

export function classifyTerminalWorkerProtocol(
  reported: unknown,
  current: number = TERMINAL_WORKER_PROTOCOL_VERSION,
): TerminalWorkerProtocolFit {
  // A version this daemon cannot read comes from a Paseo it does not know: treat it as newer.
  if (typeof reported !== "number" || !Number.isSafeInteger(reported)) return "newer";
  if (reported === current) return "current";
  if (reported === current - 1) return "previous";
  return reported < current ? "obsolete" : "newer";
}

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
      replayPreamble: string;
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
