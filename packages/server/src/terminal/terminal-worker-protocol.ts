import type {
  TerminalExitInfo,
  ServerMessage,
  ClientMessage,
  TerminalStateSnapshot,
} from "./terminal.js";
import type { TerminalState } from "../shared/messages.js";
import type { CaptureTerminalLinesResult } from "./terminal-capture.js";

export interface WorkerTerminalInfo {
  id: string;
  name: string;
  cwd: string;
  title?: string;
}

export interface WorkerCreateTerminalOptions {
  id?: string;
  cwd: string;
  name?: string;
  title?: string;
  env?: Record<string, string>;
  command?: string;
  args?: string[];
}

export interface WorkerKillAndWaitOptions {
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
}

export type TerminalWorkerRequest =
  | {
      type: "getTerminals";
      requestId: string;
      cwd: string;
    }
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
      type: "listDirectories";
      requestId: string;
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
      type: "terminalRemoved";
      terminalId: string;
      cwd: string;
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
      type: "terminalsChanged";
      cwd: string;
      terminals: WorkerTerminalInfo[];
    };

export type TerminalWorkerToParentMessage = TerminalWorkerResponse | TerminalWorkerEvent;

export type TerminalWorkerCaptureResult = CaptureTerminalLinesResult;
export type TerminalWorkerStateResult = TerminalStateSnapshot | null;
