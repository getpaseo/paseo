import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ClaudeAgentClient, convertClaudeHistoryEntry } from "./claude-agent.js";
import { useTempClaudeConfigDir } from "../../test-utils/claude-config.js";
import type {
  AgentSession,
  AgentSessionConfig,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const hasClaudeCredentials =
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

type KeyValueObject = { [key: string]: unknown };

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-agent-e2e-"));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

async function closeSessionAndCleanup(
  session: AgentSession | null | undefined,
  cwd: string
): Promise<void> {
  await session?.close();
  rmSync(cwd, { recursive: true, force: true });
}

function isKeyValueObject(value: unknown): value is KeyValueObject {
  return typeof value === "object" && value !== null;
}

function extractCommandText(input: unknown): string | null {
  if (!isKeyValueObject(input)) {
    return null;
  }
  const command = input.command;
  if (typeof command === "string" && command.length > 0) {
    return command;
  }
  if (Array.isArray(command)) {
    const tokens = command.filter((value): value is string => typeof value === "string");
    if (tokens.length > 0) {
      return tokens.join(" ");
    }
  }
  if (typeof input.description === "string" && input.description.length > 0) {
    return input.description;
  }
  return null;
}

function extractToolCommand(detail: unknown): string | null {
  if (!isKeyValueObject(detail) || typeof detail.type !== "string") {
    return null;
  }
  if (detail.type === "shell" && typeof detail.command === "string") {
    return detail.command;
  }
  if (detail.type === "unknown") {
    return extractCommandText(detail.input);
  }
  return null;
}

(hasClaudeCredentials ? describe : describe.skip)(
  "ClaudeAgentClient (SDK integration)",
  () => {
    const logger = createTestLogger();
    let restoreClaudeConfigDir: (() => void) | null = null;

    const buildConfig = (
      cwd: string,
      options?: { maxThinkingTokens?: number; modeId?: string }
    ): AgentSessionConfig => ({
      provider: "claude",
      cwd,
      modeId: options?.modeId,
      extra: {
        claude: {
          sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
          ...(typeof options?.maxThinkingTokens === "number"
            ? { maxThinkingTokens: options.maxThinkingTokens }
            : {}),
        },
      },
    });

    beforeAll(() => {
      restoreClaudeConfigDir = useTempClaudeConfigDir();
    });

    afterAll(() => {
      restoreClaudeConfigDir?.();
    });

    test(
      "responds with text",
      async () => {
        const cwd = tmpCwd();
        const client = new ClaudeAgentClient({ logger });
        const session = await client.createSession(
          buildConfig(cwd, { maxThinkingTokens: 1024 })
        );

        try {
          const marker = "CLAUDE_ACK_TOKEN";
          const result = await session.run(
            `Reply with the exact text ${marker} and then stop.`
          );
          expect(result.finalText).toContain(marker);
        } finally {
          await closeSessionAndCleanup(session, cwd);
        }
      },
      120_000
    );

    test(
      "shows the command inside permission requests",
      async () => {
        const cwd = tmpCwd();
        const client = new ClaudeAgentClient({ logger });
        const session = await client.createSession(
          buildConfig(cwd, { maxThinkingTokens: 2048 })
        );
        writeFileSync(path.join(cwd, "permission.txt"), "ok", "utf8");

        let requestedCommand: string | null = null;

        try {
          const events = session.stream(
            "Run the exact command `rm -f permission.txt` via Bash and stop."
          );

          for await (const event of events) {
            if (
              event.type === "permission_requested" &&
              event.request.kind === "tool" &&
              event.request.name.toLowerCase().includes("bash")
            ) {
              requestedCommand = extractToolCommand(
                event.request.detail ?? {
                  type: "unknown",
                  input: event.request.input ?? null,
                  output: null,
                }
              );
              await session.respondToPermission(event.request.id, {
                behavior: "allow",
              });
            }

            if (event.type === "turn_completed" || event.type === "turn_failed") {
              break;
            }
          }
        } finally {
          await closeSessionAndCleanup(session, cwd);
        }

        expect(requestedCommand).toBeTruthy();
        expect(requestedCommand?.toLowerCase()).toContain("permission.txt");
      },
      150_000
    );

    test(
      "updates session modes",
      async () => {
        const cwd = tmpCwd();
        const client = new ClaudeAgentClient({ logger });
        const session = await client.createSession(
          buildConfig(cwd, { maxThinkingTokens: 1024 })
        );

        try {
          const modes = await session.getAvailableModes();
          expect(modes.map((mode) => mode.id)).toContain("plan");

          await session.setMode("plan");
          expect(await session.getCurrentMode()).toBe("plan");

          const result = await session.run(
            "Just reply with the word PLAN to confirm you're still responsive."
          );
          expect(result.finalText.toLowerCase()).toContain("plan");
        } finally {
          await closeSessionAndCleanup(session, cwd);
        }
      },
      120_000
    );
  }
);

describe("convertClaudeHistoryEntry", () => {
  test("maps user tool results to timeline items", () => {
    const toolUseId = "toolu_test";
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: [{ type: "text", text: "file contents" }],
          },
        ],
      },
    };

    const stubTimeline: AgentTimelineItem[] = [
      {
        type: "tool_call",
        server: "editor",
        tool: "read_file",
        status: "completed",
      },
    ];

    const mapBlocks = vi.fn().mockReturnValue(stubTimeline);
    const result = convertClaudeHistoryEntry(entry, mapBlocks);

    expect(result).toEqual(stubTimeline);
    expect(mapBlocks).toHaveBeenCalledTimes(1);
    expect(Array.isArray(mapBlocks.mock.calls[0][0])).toBe(true);
  });

  test("returns user messages when no tool blocks exist", () => {
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: "Run npm test",
      },
    };

    expect(convertClaudeHistoryEntry(entry, () => [])).toEqual([
      {
        type: "user_message",
        text: "Run npm test",
      },
    ]);
  });

  test("converts compact boundary metadata variants", () => {
    const fixtures = [
      {
        entry: {
          type: "system",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "manual", preTokens: 12 },
        },
        expected: { trigger: "manual", preTokens: 12 },
      },
      {
        entry: {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 34 },
        },
        expected: { trigger: "manual", preTokens: 34 },
      },
      {
        entry: {
          type: "system",
          subtype: "compact_boundary",
          compactionMetadata: { trigger: "auto", preTokens: 56 },
        },
        expected: { trigger: "auto", preTokens: 56 },
      },
    ] as const;

    for (const fixture of fixtures) {
      expect(convertClaudeHistoryEntry(fixture.entry, () => [])).toEqual([
        {
          type: "compaction",
          status: "completed",
          trigger: fixture.expected.trigger,
          preTokens: fixture.expected.preTokens,
        },
      ]);
    }
  });

  test("skips synthetic user entries", () => {
    const entry = {
      type: "user",
      isSynthetic: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "Base directory for this skill: /tmp/skill" }],
      },
    };

    const mapBlocks = vi.fn().mockReturnValue([]);
    const result = convertClaudeHistoryEntry(entry, mapBlocks);

    expect(result).toEqual([]);
    expect(mapBlocks).not.toHaveBeenCalled();
  });

  test("maps task notifications to synthetic tool calls", () => {
    const entry = {
      type: "system",
      subtype: "task_notification",
      uuid: "task-note-system-1",
      task_id: "bg-fail-1",
      status: "failed",
      summary: "Background task failed",
      output_file: "/tmp/bg-fail-1.txt",
    };

    expect(convertClaudeHistoryEntry(entry, () => [])).toEqual([
      {
        type: "tool_call",
        callId: "task_notification_task-note-system-1",
        name: "task_notification",
        status: "failed",
        error: { message: "Background task failed" },
        detail: {
          type: "plain_text",
          label: "Background task failed",
          icon: "wrench",
          text: "Background task failed",
        },
        metadata: {
          synthetic: true,
          source: "claude_task_notification",
          taskId: "bg-fail-1",
          status: "failed",
          outputFile: "/tmp/bg-fail-1.txt",
        },
      },
    ]);
  });

  test("passes assistant content blocks through to the mapper", () => {
    const entry = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "text", text: "Here is my answer." },
        ],
      },
    };

    const mappedTimeline = [
      { type: "reasoning", text: "Let me reason about this..." },
      { type: "assistant_message", text: "Here is my answer." },
    ];
    const mapBlocks = vi.fn().mockReturnValue(mappedTimeline);

    expect(convertClaudeHistoryEntry(entry, mapBlocks)).toEqual(mappedTimeline);
    expect(mapBlocks).toHaveBeenCalledWith(entry.message.content);
  });
});

// NOTE: Turn handoff integration tests are covered by the daemon E2E test:
// "interrupting message should produce coherent text without garbling from race condition"
// in daemon.e2e.test.ts which exercises the full flow through the WebSocket API.

describe("ClaudeAgentClient.listModels", () => {
  const logger = createTestLogger();

  test(
    "returns models with required fields",
    async () => {
      const client = new ClaudeAgentClient({ logger });
      const models = await client.listModels();

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);

      for (const model of models) {
        expect(model.provider).toBe("claude");
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(typeof model.label).toBe("string");
        expect(model.label.length).toBeGreaterThan(0);
      }

      const modelIds = models.map((model) => model.id);
      expect(
        modelIds.some(
          (id) =>
            id.includes("claude") ||
            id.includes("sonnet") ||
            id.includes("opus") ||
            id.includes("haiku")
        )
      ).toBe(true);
    },
    60_000
  );
});
