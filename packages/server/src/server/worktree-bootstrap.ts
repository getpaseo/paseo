import { v4 as uuidv4 } from "uuid";
import type { Logger } from "pino";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import {
  createWorktree,
  getWorktreeTerminalSpecs,
  runWorktreeSetupCommands,
  WorktreeSetupError,
  type WorktreeConfig,
  type WorktreeSetupCommandResult,
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
  logger?: Logger;
}

export interface CreateAgentWorktreeOptions {
  cwd: string;
  branchName: string;
  baseBranch: string;
  worktreeSlug: string;
  paseoHome?: string;
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

function buildSetupTimelineItem(input: {
  callId: string;
  status: "running" | "completed" | "failed";
  worktree: WorktreeConfig;
  results: WorktreeSetupCommandResult[];
  errorMessage: string | null;
}): AgentTimelineItem {
  const detailInput = {
    worktreePath: input.worktree.worktreePath,
    branchName: input.worktree.branchName,
  };
  const detailOutput = {
    worktreePath: input.worktree.worktreePath,
    commands: input.results.map((result) => ({
      command: result.command,
      cwd: result.cwd,
      exitCode: result.exitCode,
      output: `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim(),
    })),
  };

  if (input.status === "running") {
    return {
      type: "tool_call",
      name: "paseo_worktree_setup",
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
      name: "paseo_worktree_setup",
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
    name: "paseo_worktree_setup",
    callId: input.callId,
    status: "failed",
    detail: {
      type: "unknown",
      input: detailInput,
      output: detailOutput,
    },
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

async function runWorktreeTerminalBootstrap(
  options: RunAsyncWorktreeBootstrapOptions
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
      });
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

  try {
    const started = await options.appendTimelineItem(
      buildSetupTimelineItem({
        callId: setupCallId,
        status: "running",
        worktree: options.worktree,
        results: [],
        errorMessage: null,
      })
    );
    if (!started) {
      return;
    }

    setupResults = await runWorktreeSetupCommands({
      worktreePath: options.worktree.worktreePath,
      branchName: options.worktree.branchName,
      cleanupOnFailure: false,
    });

    await options.appendTimelineItem(
      buildSetupTimelineItem({
        callId: setupCallId,
        status: "completed",
        worktree: options.worktree,
        results: setupResults,
        errorMessage: null,
      })
    );
  } catch (error) {
    if (error instanceof WorktreeSetupError) {
      setupResults = error.results;
    }
    const message = error instanceof Error ? error.message : String(error);
    await options.appendTimelineItem(
      buildSetupTimelineItem({
        callId: setupCallId,
        status: "failed",
        worktree: options.worktree,
        results: setupResults,
        errorMessage: message,
      })
    );
    return;
  }

  await runWorktreeTerminalBootstrap(options);
}
