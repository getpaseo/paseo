import type {
  TerminalExitInfo,
  ServerMessage,
  ClientMessage,
  TerminalPromptState,
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
  shellIntegrationExpected: boolean;
  // Carried on creation so the parent starts from the worker's own state
  // instead of inferring it from whichever events happen to arrive first.
  promptState: TerminalPromptState;
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
  // Both of these exist because prompt state cannot be trusted from the parent:
  // the parent holds a copy that lags by one IPC hop, so "not announced yet" and
  // "the announce is in flight" look identical there, and a check-then-send pair
  // can straddle a state change. Answering in the worker, against the live
  // session, removes the guesswork. See docs/terminal-readiness.md.
  | {
      type: "getPromptState";
      requestId: string;
      terminalId: string;
    }
  | {
      type: "sendInputIfAtPrompt";
      requestId: string;
      terminalId: string;
      data: string;
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
      type: "killAll";
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
      type: "terminalPromptState";
      terminalId: string;
      state: TerminalPromptState;
    }
  | {
      type: "terminalActivityChange";
      terminalId: string;
      activity: TerminalActivity | null;
      previous: TerminalActivity | null;
    };

export type TerminalWorkerToParentMessage = TerminalWorkerResponse | TerminalWorkerEvent;

export type TerminalWorkerCaptureResult = CaptureTerminalLinesResult;
export type TerminalWorkerPromptStateResult = TerminalPromptState | null;
export interface TerminalWorkerSendIfAtPromptResult {
  // false when the shell was not at its prompt at write time: nothing was sent.
  sent: boolean;
}
// The worker fills TerminalStateSnapshot.replayPreamble on getTerminalState so
// the parent can cache the input-mode preamble instead of re-deriving it.
export type TerminalWorkerStateResult = TerminalStateSnapshot | null;
