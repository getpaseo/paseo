export type LoopStatus = "running" | "succeeded" | "failed" | "stopped";

export interface LoopLogEntry {
  seq: number;
  timestamp: string;
  iteration: number | null;
  source: "loop" | "worker" | "verifier" | "verify-check";
  level: "info" | "error";
  text: string;
}

export interface LoopVerifyCheckResult {
  command: string;
  exitCode: number;
  passed: boolean;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
}

export interface LoopVerifyPromptResult {
  passed: boolean;
  reason: string;
  verifierAgentId: string | null;
  startedAt: string;
  completedAt: string;
}

export interface LoopIterationRecord {
  index: number;
  workerAgentId: string | null;
  workerStartedAt: string;
  workerCompletedAt: string | null;
  verifierAgentId: string | null;
  status: "running" | "succeeded" | "failed" | "stopped";
  workerOutcome: "completed" | "failed" | "canceled" | null;
  failureReason: string | null;
  verifyChecks: LoopVerifyCheckResult[];
  verifyPrompt: LoopVerifyPromptResult | null;
}

export interface LoopRecord {
  id: string;
  name: string | null;
  prompt: string;
  cwd: string;
  provider: "claude" | "codex" | "opencode";
  verifyPrompt: string | null;
  verifyChecks: string[];
  sleepMs: number;
  maxIterations: number | null;
  maxTimeMs: number | null;
  status: LoopStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string | null;
  stopRequestedAt: string | null;
  iterations: LoopIterationRecord[];
  logs: LoopLogEntry[];
  nextLogSeq: number;
  activeIteration: number | null;
  activeWorkerAgentId: string | null;
  activeVerifierAgentId: string | null;
}

export interface LoopListItem {
  id: string;
  name: string | null;
  status: LoopStatus;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  activeIteration: number | null;
}

export interface LoopLogsResult {
  loop: LoopRecord;
  entries: LoopLogEntry[];
  nextCursor: number;
}

export interface LoopRunPayload {
  requestId: string;
  loop: LoopRecord | null;
  error: string | null;
}

export interface LoopListPayload {
  requestId: string;
  loops: LoopListItem[];
  error: string | null;
}

export interface LoopInspectPayload {
  requestId: string;
  loop: LoopRecord | null;
  error: string | null;
}

export interface LoopLogsPayload {
  requestId: string;
  loop: LoopRecord | null;
  entries: LoopLogEntry[];
  nextCursor: number;
  error: string | null;
}

export interface LoopStopPayload {
  requestId: string;
  loop: LoopRecord | null;
  error: string | null;
}

export interface LoopRunInput {
  prompt: string;
  cwd: string;
  verifyPrompt?: string;
  verifyChecks?: string[];
  name?: string;
  sleepMs?: number;
  maxIterations?: number;
  maxTimeMs?: number;
}

export interface LoopDaemonClient {
  loopRun(input: LoopRunInput): Promise<LoopRunPayload>;
  loopList(): Promise<LoopListPayload>;
  loopInspect(id: string): Promise<LoopInspectPayload>;
  loopLogs(id: string, afterSeq?: number): Promise<LoopLogsPayload>;
  loopStop(id: string): Promise<LoopStopPayload>;
  close(): Promise<void>;
}
