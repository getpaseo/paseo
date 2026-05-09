import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { query, type Options, type Query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import {
  createProviderEnv,
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { buildSelfNodeCommand } from "../../../paseo-env.js";
import { spawnProcess } from "../../../../utils/spawn.js";

// Keep the raw SDK query import in this module only. Claude process launch behavior
// must stay shared between production and tests so Windows .cmd/.bat handling cannot
// diverge from the daemon path.

export type ClaudeOptions = Options;
export type ClaudeQueryInput = Parameters<typeof query>[0] & { options: ClaudeOptions };
export type ClaudeQueryFactory = (input: ClaudeQueryInput) => Query;

export interface ClaudeQueryContext {
  runtimeSettings?: ProviderRuntimeSettings;
  launchEnv?: Record<string, string>;
  queryFactory?: ClaudeQueryFactory;
}

function isChildProcessWithStreams(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

function resolveClaudeSpawnCommand(
  spawnOptions: SpawnOptions,
  runtimeSettings?: ProviderRuntimeSettings,
): { command: string; args: string[] } {
  const commandConfig = runtimeSettings?.command;
  if (!commandConfig || commandConfig.mode === "default") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args],
    };
  }

  if (commandConfig.mode === "append") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args, ...(commandConfig.args ?? [])],
    };
  }

  return {
    command: commandConfig.argv[0],
    args: [...commandConfig.argv.slice(1), ...spawnOptions.args],
  };
}

function applyRuntimeSettingsToClaudeOptions(
  options: ClaudeOptions,
  runtimeSettings?: ProviderRuntimeSettings,
  launchEnv?: Record<string, string>,
): ClaudeOptions {
  return {
    ...options,
    spawnClaudeCodeProcess: (spawnOptions) => {
      const resolved = resolveClaudeSpawnCommand(spawnOptions, runtimeSettings);
      // When the SDK passes a default JS runtime ("node"/"bun"), replace it with
      // process.execPath — the actual node binary running the daemon. This avoids
      // PATH lookup failures in the managed runtime bundle.
      // When the SDK passes a native binary path (from pathToClaudeCodeExecutable)
      // or the user overrides the command via runtime settings, use that directly.
      const isDefaultRuntime = resolved.command === "node" || resolved.command === "bun";
      const providerEnvSpec = createProviderEnvSpec({
        baseEnv: spawnOptions.env,
        runtimeSettings,
        overlays: [launchEnv],
      });
      const providerEnv = createProviderEnv({
        baseEnv: spawnOptions.env,
        runtimeSettings,
        overlays: [launchEnv],
      });
      const selfNodeCommand = isDefaultRuntime
        ? buildSelfNodeCommand(resolved.args, providerEnv)
        : null;
      const command = selfNodeCommand?.command ?? resolved.command;
      const args = selfNodeCommand?.args ?? resolved.args;
      const child = spawnProcess(command, args, {
        cwd: spawnOptions.cwd,
        ...(selfNodeCommand
          ? { env: selfNodeCommand.env, envMode: "internal" as const }
          : providerEnvSpec),
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "pipe"],
        // Bypass cmd.exe on Windows: the SDK passes --mcp-config with inline JSON
        // containing double quotes, which cmd.exe mangles (strips quotes, breaks parsing).
        // The command is always a resolved binary path, so shell routing is unnecessary.
        shell: false,
      });
      if (typeof options.stderr === "function") {
        child.stderr?.on("data", (chunk: Buffer | string) => {
          options.stderr?.(chunk.toString());
        });
      }
      if (!isChildProcessWithStreams(child)) {
        throw new Error("Claude process was spawned without stdio streams");
      }
      return child;
    },
  };
}

export function claudeQuery(input: ClaudeQueryInput, context: ClaudeQueryContext = {}): Query {
  const launchQuery = context.queryFactory ?? query;
  return launchQuery({
    ...input,
    options: applyRuntimeSettingsToClaudeOptions(
      input.options,
      context.runtimeSettings,
      context.launchEnv,
    ),
  });
}
