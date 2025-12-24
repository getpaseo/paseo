import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function tmpCwd(): string {
  return mkdtempSync(path.join(os.tmpdir(), "codex-mcp-e2e-"));
}

function useTempCodexSessionDir(): () => void {
  const prevSessionDir = process.env.CODEX_SESSION_DIR;
  const prevHome = process.env.CODEX_HOME;
  return () => {
    if (prevSessionDir === undefined) {
      delete process.env.CODEX_SESSION_DIR;
    } else {
      process.env.CODEX_SESSION_DIR = prevSessionDir;
    }
    if (prevHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevHome;
    }
  };
}

async function loadCodexMcpAgentClient(): Promise<{
  new (): {
    createSession: (config: AgentSessionConfig) => Promise<{
      stream: (prompt: string) => AsyncGenerator<AgentStreamEvent>;
      close: () => Promise<void>;
    }>;
  };
}> {
  try {
    return (await import("./codex-mcp-agent.js")) as {
      CodexMcpAgentClient: new () => {
        createSession: (config: AgentSessionConfig) => Promise<{
          stream: (prompt: string) => AsyncGenerator<AgentStreamEvent>;
          close: () => Promise<void>;
        }>;
      };
    };
  } catch (error) {
    throw new Error(
      `Failed to import codex-mcp-agent: ${(error as Error).message}`
    );
  }
}

function providerFromEvent(event: AgentStreamEvent): string | undefined {
  return (event as { provider?: string }).provider;
}

function extractExitCode(output: unknown): number | undefined {
  if (!output || typeof output !== "object") {
    return undefined;
  }
  const outputRecord = output as Record<string, unknown>;
  const direct = outputRecord.exitCode ?? outputRecord.exit_code;
  if (typeof direct === "number") {
    return direct;
  }
  const metadata = outputRecord.metadata;
  if (metadata && typeof metadata === "object") {
    const metadataRecord = metadata as Record<string, unknown>;
    const metaCode = metadataRecord.exit_code ?? metadataRecord.exitCode;
    if (typeof metaCode === "number") {
      return metaCode;
    }
  }
  return undefined;
}

describe("CodexMcpAgentClient (MCP integration)", () => {
  test(
    "maps MCP stream events into timeline items with stable call ids",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
      } as AgentSessionConfig;

      let session: Awaited<ReturnType<typeof client.createSession>> | null =
        null;
      const toolCalls: ToolCallItem[] = [];
      const rawCommandEvents: unknown[] = [];
      let sawAssistant = false;
      let sawReasoning = false;

      try {
        session = await client.createSession(config);

        const prompt = [
          "1. Run the command `pwd` using your shell tool and wait for it to finish.",
          "2. Use apply_patch (not the shell) to create a file named mcp-event.log containing the single line 'ok'.",
          "3. After the patch succeeds, reply DONE and stop.",
        ].join("\n");

        for await (const event of session.stream(prompt)) {
          const provider = providerFromEvent(event);
          if (event.type === "timeline" && provider === "codex-mcp") {
            if (event.item.type === "assistant_message") {
              sawAssistant = true;
            }
            if (event.item.type === "reasoning") {
              sawReasoning = true;
            }
            if (event.item.type === "tool_call" && event.item.server !== "permission") {
              toolCalls.push(event.item);
            }
          }

          const rawEvent = (event as { type?: string; raw?: unknown }).type === "provider_event"
            ? (event as { raw?: unknown }).raw
            : null;
          if (rawEvent && typeof rawEvent === "object") {
            const itemType = (rawEvent as { item?: { type?: string } }).item?.type;
            if (itemType === "command_execution") {
              rawCommandEvents.push(rawEvent);
            }
          }

          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(sawAssistant).toBe(true);
        expect(sawReasoning).toBe(true);
        expect(toolCalls.length).toBeGreaterThan(0);

        const uniqueIds = new Set(
          toolCalls.map((item) => (typeof item.callId === "string" ? item.callId : ""))
        );
        expect(uniqueIds.size).toBeGreaterThan(0);
        for (const toolCall of toolCalls) {
          expect(typeof toolCall.callId).toBe("string");
          expect((toolCall.callId ?? "").trim().length).toBeGreaterThan(0);
        }

        const commandToolCall = toolCalls.find(
          (item) => item.server === "command"
        );
        expect(commandToolCall).toBeTruthy();

        const exitCode = extractExitCode(commandToolCall?.output);
        if (exitCode === undefined) {
          throw new Error(
            `Missing exit code in command output. Raw events:\n${JSON.stringify(
              rawCommandEvents[0] ?? null,
              null,
              2
            )}`
          );
        }
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "emits an error timeline item for failed MCP turns",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
      } as AgentSessionConfig;

      let session: Awaited<ReturnType<typeof client.createSession>> | null =
        null;
      let sawErrorTimeline = false;
      const errorEvents: AgentStreamEvent[] = [];

      try {
        session = await client.createSession(config);

        const prompt = [
          "Run the command `bash -lc \"exit 7\"` using your shell tool.",
          "After the command finishes (even if it fails), reply DONE and stop.",
        ].join("\n");

        for await (const event of session.stream(prompt)) {
          const provider = providerFromEvent(event);
          if (event.type === "timeline" && provider === "codex-mcp") {
            if (event.item.type === "error") {
              sawErrorTimeline = true;
            }
          }
          if (event.type === "turn_failed") {
            errorEvents.push(event);
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(sawErrorTimeline).toBe(true);
        expect(errorEvents.length).toBeGreaterThan(0);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );
});
