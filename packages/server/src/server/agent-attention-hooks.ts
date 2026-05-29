import { spawn } from "node:child_process";
import type pino from "pino";

import type { AgentProvider } from "./agent/agent-sdk-types.js";
import type { PushPayload } from "./push/notifications.js";

const DEFAULT_AGENT_ATTENTION_HOOK_TIMEOUT_MS = 5000;

export interface AgentAttentionHookConfig {
  command: string[];
  timeoutMs?: number;
}

export interface AgentAttentionHookPayload {
  agentId: string;
  provider: AgentProvider;
  reason: "finished" | "error" | "permission";
  notification: PushPayload;
}

export interface AgentAttentionHookRunner {
  run(payload: AgentAttentionHookPayload): Promise<void>;
}

export function createAgentAttentionHookRunner(
  logger: pino.Logger,
  config: AgentAttentionHookConfig,
): AgentAttentionHookRunner {
  const command = config.command[0];
  const args = config.command.slice(1);
  const timeoutMs = config.timeoutMs ?? DEFAULT_AGENT_ATTENTION_HOOK_TIMEOUT_MS;

  return {
    async run(payload) {
      let resolveRun: (() => void) | undefined;
      const completed = new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      const child = spawn(command, args, {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolveRun?.();
      };
      const timeout = setTimeout(() => {
        logger.warn({ timeoutMs }, "Agent attention hook timed out");
        child.kill();
        finish();
      }, timeoutMs);

      child.on("error", (err) => {
        logger.warn({ err }, "Failed to start agent attention hook");
        finish();
      });
      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          logger.warn({ code, signal }, "Agent attention hook exited unsuccessfully");
        }
        finish();
      });
      child.stdin.on("error", (err) => {
        if (settled) {
          return;
        }
        logger.warn({ err }, "Failed to write agent attention hook payload");
        child.kill();
        finish();
      });

      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        child.stdin.end();
      } catch (err) {
        logger.warn({ err }, "Failed to write agent attention hook payload");
        child.kill();
        finish();
      }

      await completed;
    },
  };
}
