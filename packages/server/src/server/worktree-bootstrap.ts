import { v4 as uuidv4 } from "uuid";
import type { Logger } from "pino";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";
import {
  createWorktree,
  getWorktreeTerminalSpecs,
  resolveWorktreeRuntimeEnv,
  runWorktreeSetupCommands,
  WorktreeSetupError,
  type WorktreeConfig,
  type WorktreeSetupCommandResult,
  type WorktreeRuntimeEnv,
} from "../utils/worktree.js";
import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";

export interface WorktreeBootstrapTerminalResult {
  name: string | null;
  command: string;
  status: "started" | "failed";
  terminalId: string | null;
  error: string | null;
}

export interface RunAsyncWorktreeBootstrapOptions {
  agentId: string;
  worktree: WorktreeConfig;
  terminalManager: TerminalManager | null;
  appendTimelineItem: (item: AgentTimelineItem) => Promise<boolean>;
  emitLiveTimelineItem?: (item: AgentTimelineItem) => Promise<boolean>;
  logger?: Logger;
}

export interface CreateAgentWorktreeOptions {
  cwd: string;
  branchName: string;
  baseBranch: string;
  worktreeSlug: string;
  paseoHome?: string;
}

const MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES = 64 * 1024;
const WORKTREE_SETUP_TRUNCATION_MARKER = "\n...<output truncated in the middle>...\n";
const WORKTREE_BOOTSTRAP_TERMINAL_READY_TIMEOUT_MS = 1_500;

type MiddleTruncationAccumulator = {
  totalBytes: number;
  head: string;
  tail: string;
  truncated: boolean;
};

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sliceFirstBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function sliceLastBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function createMiddleTruncationAccumulator(): MiddleTruncationAccumulator {
  return {
    totalBytes: 0,
    head: "",
    tail: "",
    truncated: false,
  };
}

function getHeadTailBudgets(maxBytes: number): { headBytes: number; tailBytes: number } {
  const markerBytes = byteLength(WORKTREE_SETUP_TRUNCATION_MARKER);
  const availableBytes = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.floor(availableBytes / 2);
  const tailBytes = availableBytes - headBytes;
  return { headBytes, tailBytes };
}

function appendToMiddleTruncationAccumulator(
  accumulator: MiddleTruncationAccumulator,
  chunk: string
): void {
  if (!chunk) {
    return;
  }
  accumulator.totalBytes += byteLength(chunk);

  if (!accumulator.truncated) {
    const combined = `${accumulator.head}${chunk}`;
    if (byteLength(combined) <= MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES) {
      accumulator.head = combined;
      return;
    }
    const { headBytes, tailBytes } = getHeadTailBudgets(
      MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES
    );
    accumulator.head = sliceFirstBytes(combined, headBytes);
    accumulator.tail = sliceLastBytes(combined, tailBytes);
    accumulator.truncated = true;
    return;
  }

  const { tailBytes } = getHeadTailBudgets(MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES);
  accumulator.tail = sliceLastBytes(`${accumulator.tail}${chunk}`, tailBytes);
}

function truncateTextInMiddle(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  if (maxBytes <= 0 || !text) {
    return { text: "", truncated: text.length > 0 };
  }
  if (byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  const { headBytes, tailBytes } = getHeadTailBudgets(maxBytes);
  return {
    text: `${sliceFirstBytes(text, headBytes)}${WORKTREE_SETUP_TRUNCATION_MARKER}${sliceLastBytes(text, tailBytes)}`,
    truncated: true,
  };
}

function renderMiddleTruncationAccumulator(
  accumulator: MiddleTruncationAccumulator
): { text: string; truncated: boolean } {
  if (!accumulator.truncated) {
    return { text: accumulator.head, truncated: false };
  }
  return {
    text: `${accumulator.head}${WORKTREE_SETUP_TRUNCATION_MARKER}${accumulator.tail}`,
    truncated: true,
  };
}

export async function createAgentWorktree(
  options: CreateAgentWorktreeOptions
): Promise<WorktreeConfig> {
  return createWorktree({
    branchName: options.branchName,
    cwd: options.cwd,
    baseBranch: options.baseBranch,
    worktreeSlug: options.worktreeSlug,
    runSetup: false,
    paseoHome: options.paseoHome,
  });
}

function formatDurationMs(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function commandStatusFromResult(
  result: WorktreeSetupCommandResult
): "running" | "completed" | "failed" {
  if (result.exitCode === null) {
    return "running";
  }
  return result.exitCode === 0 ? "completed" : "failed";
}

function buildWorktreeSetupLog(input: {
  results: WorktreeSetupCommandResult[];
  outputAccumulatorsByIndex?: Map<number, MiddleTruncationAccumulator>;
}): { log: string; truncated: boolean } {
  const { results, outputAccumulatorsByIndex } = input;
  if (results.length === 0) {
    return {
      log: "",
      truncated: false,
    };
  }

  const lines: string[] = [];
  let anyTruncated = false;
  const total = results.length;
  for (const [index, result] of results.entries()) {
    lines.push(`==> [${index + 1}/${total}] Running: ${result.command}`);
    const accumulator = outputAccumulatorsByIndex?.get(index + 1);
    const output = accumulator
      ? renderMiddleTruncationAccumulator(accumulator)
      : truncateTextInMiddle(
          `${result.stdout ?? ""}${result.stderr ?? ""}`,
          MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES
        );
    if (output.text.length > 0) {
      lines.push(output.text.replace(/\n$/, ""));
    }
    if (output.truncated) {
      anyTruncated = true;
    }
    if (result.exitCode !== null) {
      lines.push(
        `<== [${index + 1}/${total}] Exit ${result.exitCode} in ${formatDurationMs(result.durationMs)}`
      );
    }
  }
  return {
    log: lines.join("\n"),
    truncated: anyTruncated,
  };
}

function buildSetupTimelineItem(input: {
  callId: string;
  status: "running" | "completed" | "failed";
  worktree: WorktreeConfig;
  results: WorktreeSetupCommandResult[];
  outputAccumulatorsByIndex?: Map<number, MiddleTruncationAccumulator>;
  errorMessage: string | null;
}): AgentTimelineItem {
  const commands = input.results.map((result, index) => ({
    index: index + 1,
    command: result.command,
    cwd: result.cwd,
    status: commandStatusFromResult(result),
    exitCode: result.exitCode,
    ...(result.durationMs > 0 ? { durationMs: result.durationMs } : {}),
  }));
  const renderedLog = buildWorktreeSetupLog({
    results: input.results,
    outputAccumulatorsByIndex: input.outputAccumulatorsByIndex,
  });
  const detail = {
    type: "worktree_setup" as const,
    worktreePath: input.worktree.worktreePath,
    branchName: input.worktree.branchName,
    log: renderedLog.log,
    commands,
    ...(renderedLog.truncated ? { truncated: true } : {}),
  };

  if (input.status === "running") {
    return {
      type: "tool_call",
      name: "paseo_worktree_setup",
      callId: input.callId,
      status: "running",
      detail,
      error: null,
    };
  }

  if (input.status === "completed") {
    return {
      type: "tool_call",
      name: "paseo_worktree_setup",
      callId: input.callId,
      status: "completed",
      detail,
      error: null,
    };
  }

  return {
    type: "tool_call",
    name: "paseo_worktree_setup",
    callId: input.callId,
    status: "failed",
    detail,
    error: { message: input.errorMessage ?? "Worktree setup failed" },
  };
}

function buildTerminalTimelineItem(input: {
  callId: string;
  status: "running" | "completed" | "failed";
  worktree: WorktreeConfig;
  results: WorktreeBootstrapTerminalResult[];
  errorMessage: string | null;
}): AgentTimelineItem {
  const detailInput = {
    worktreePath: input.worktree.worktreePath,
    branchName: input.worktree.branchName,
  };
  const detailOutput = {
    worktreePath: input.worktree.worktreePath,
    terminals: input.results,
  };

  if (input.status === "running") {
    return {
      type: "tool_call",
      name: "paseo_worktree_terminals",
      callId: input.callId,
      status: "running",
      detail: {
        type: "unknown",
        input: detailInput,
        output: null,
      },
      error: null,
    };
  }

  if (input.status === "completed") {
    return {
      type: "tool_call",
      name: "paseo_worktree_terminals",
      callId: input.callId,
      status: "completed",
      detail: {
        type: "unknown",
        input: detailInput,
        output: detailOutput,
      },
      error: null,
    };
  }

  return {
    type: "tool_call",
    name: "paseo_worktree_terminals",
    callId: input.callId,
    status: "failed",
    detail: {
      type: "unknown",
      input: detailInput,
      output: detailOutput,
    },
    error: { message: input.errorMessage ?? "Worktree terminal bootstrap failed" },
  };
}

async function waitForTerminalBootstrapReadiness(
  terminal: Pick<TerminalSession, "getOutputOffset" | "subscribeRaw">
): Promise<void> {
  if (terminal.getOutputOffset() > 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      resolve();
    };

    const rawSubscription = terminal.subscribeRaw(() => {
      finish();
    });
    unsubscribe = rawSubscription.unsubscribe;

    if (terminal.getOutputOffset() > 0) {
      finish();
      return;
    }

    timeout = setTimeout(finish, WORKTREE_BOOTSTRAP_TERMINAL_READY_TIMEOUT_MS);
  });
}

async function runWorktreeTerminalBootstrap(
  options: RunAsyncWorktreeBootstrapOptions,
  runtimeEnv: WorktreeRuntimeEnv
): Promise<void> {
  const terminalSpecs = getWorktreeTerminalSpecs(options.worktree.worktreePath);
  if (terminalSpecs.length === 0) {
    return;
  }

  const callId = uuidv4();
  const started = await options.appendTimelineItem(
    buildTerminalTimelineItem({
      callId,
      status: "running",
      worktree: options.worktree,
      results: [],
      errorMessage: null,
    })
  );
  if (!started) {
    return;
  }

  if (!options.terminalManager) {
    await options.appendTimelineItem(
      buildTerminalTimelineItem({
        callId,
        status: "failed",
        worktree: options.worktree,
        results: [],
        errorMessage: "Terminal manager not available",
      })
    );
    return;
  }

  const results: WorktreeBootstrapTerminalResult[] = [];
  for (const spec of terminalSpecs) {
    try {
      const terminal = await options.terminalManager.createTerminal({
        cwd: options.worktree.worktreePath,
        name: spec.name,
        env: runtimeEnv,
      });
      await waitForTerminalBootstrapReadiness(terminal);
      terminal.send({
        type: "input",
        data: `${spec.command}\r`,
      });
      results.push({
        name: terminal.name ?? spec.name ?? null,
        command: spec.command,
        status: "started",
        terminalId: terminal.id,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn(
        { agentId: options.agentId, command: spec.command, err: error },
        "Failed to bootstrap worktree terminal"
      );
      results.push({
        name: spec.name ?? null,
        command: spec.command,
        status: "failed",
        terminalId: null,
        error: message,
      });
    }
  }

  await options.appendTimelineItem(
    buildTerminalTimelineItem({
      callId,
      status: "completed",
      worktree: options.worktree,
      results,
      errorMessage: null,
    })
  );
}

export async function runAsyncWorktreeBootstrap(
  options: RunAsyncWorktreeBootstrapOptions
): Promise<void> {
  const setupCallId = uuidv4();
  let setupResults: WorktreeSetupCommandResult[] = [];
  let runtimeEnv: WorktreeRuntimeEnv | null = null;
  const emitLiveTimelineItem = options.emitLiveTimelineItem;
  const runningResultsByIndex = new Map<number, WorktreeSetupCommandResult>();
  const outputAccumulatorsByIndex = new Map<number, MiddleTruncationAccumulator>();
  let liveEmitQueue = Promise.resolve();

  const queueLiveRunningEmit = () => {
    if (!emitLiveTimelineItem) {
      return;
    }
    const runningResults = Array.from(runningResultsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, result]) => result);
    liveEmitQueue = liveEmitQueue.then(async () => {
      try {
        await emitLiveTimelineItem(
          buildSetupTimelineItem({
            callId: setupCallId,
            status: "running",
            worktree: options.worktree,
            results: runningResults,
            outputAccumulatorsByIndex,
            errorMessage: null,
          })
        );
      } catch (error) {
        options.logger?.warn(
          { err: error, agentId: options.agentId },
          "Failed to emit live worktree setup timeline update"
        );
      }
    });
  };

  try {
    runtimeEnv = await resolveWorktreeRuntimeEnv({
      worktreePath: options.worktree.worktreePath,
      branchName: options.worktree.branchName,
    });
    options.terminalManager?.registerCwdEnv({
      cwd: options.worktree.worktreePath,
      env: runtimeEnv,
    });

    setupResults = await runWorktreeSetupCommands({
      worktreePath: options.worktree.worktreePath,
      branchName: options.worktree.branchName,
      cleanupOnFailure: false,
      runtimeEnv,
      onEvent: (event) => {
        const existing = runningResultsByIndex.get(event.index);
        const baseResult: WorktreeSetupCommandResult = existing ?? {
          command: event.command,
          cwd: event.cwd,
          stdout: "",
          stderr: "",
          exitCode: null,
          durationMs: 0,
        };
        if (event.type === "output") {
          const outputAccumulator =
            outputAccumulatorsByIndex.get(event.index) ??
            createMiddleTruncationAccumulator();
          appendToMiddleTruncationAccumulator(outputAccumulator, event.chunk);
          outputAccumulatorsByIndex.set(event.index, outputAccumulator);
          runningResultsByIndex.set(event.index, {
            ...baseResult,
            // Keep the timeline command model lightweight; output is carried in
            // outputAccumulatorsByIndex.
            stdout: baseResult.stdout,
            stderr: baseResult.stderr,
          });
          queueLiveRunningEmit();
          return;
        }
        if (event.type === "command_completed") {
          runningResultsByIndex.set(event.index, {
            ...baseResult,
            stdout: event.stdout,
            stderr: event.stderr,
            exitCode: event.exitCode,
            durationMs: event.durationMs,
          });
          queueLiveRunningEmit();
          return;
        }
        runningResultsByIndex.set(event.index, baseResult);
        queueLiveRunningEmit();
      },
    });
    await liveEmitQueue;

    const completed = await options.appendTimelineItem(
      buildSetupTimelineItem({
        callId: setupCallId,
        status: "completed",
        worktree: options.worktree,
        results: setupResults,
        outputAccumulatorsByIndex,
        errorMessage: null,
      })
    );
    if (!completed) {
      return;
    }
  } catch (error) {
    if (error instanceof WorktreeSetupError) {
      setupResults = error.results;
    }
    await liveEmitQueue;
    const message = error instanceof Error ? error.message : String(error);
    await options.appendTimelineItem(
      buildSetupTimelineItem({
        callId: setupCallId,
        status: "failed",
        worktree: options.worktree,
        results: setupResults,
        outputAccumulatorsByIndex,
        errorMessage: message,
      })
    );
    return;
  }

  await runWorktreeTerminalBootstrap(options, runtimeEnv);
}
