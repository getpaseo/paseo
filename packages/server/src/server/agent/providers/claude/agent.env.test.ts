import type { Query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentLaunchContext, AgentSession } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

async function writeTranscript(input: {
  transcriptPath: string;
  sessionId: string;
  cwd: string;
  text: string;
}): Promise<string> {
  await fs.mkdir(path.dirname(input.transcriptPath), { recursive: true });
  await fs.writeFile(
    input.transcriptPath,
    `${JSON.stringify({
      type: "user",
      uuid: `${input.sessionId}-prompt`,
      sessionId: input.sessionId,
      cwd: input.cwd,
      message: { role: "user", content: input.text },
    })}\n`,
  );
  return input.transcriptPath;
}

async function readHistoryTexts(session: AgentSession): Promise<string[]> {
  const texts: string[] = [];
  for await (const event of session.streamHistory()) {
    if (event.type === "timeline" && event.item.type === "user_message") {
      texts.push(event.item.text);
    }
  }
  return texts;
}

describe("Claude SDK env", () => {
  test("resumes history from the transcript path Claude reports", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-transcript-"));
    const cwd = process.cwd();
    const sessionId = "reported-transcript-session";
    const transcriptPath = await writeTranscript({
      transcriptPath: path.join(claudeProjectDirSync(cwd, { configDir }), `${sessionId}.jsonl`),
      sessionId,
      cwd,
      text: "History from reported transcript",
    });
    let session: AgentSession | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      const query = createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]);
      const nextEvent = query.next.bind(query);
      let delivered = 0;
      query.next = async () => {
        if (delivered === 1) {
          // AgentManager may snapshot persistence before a prompt's hook callback lands.
          session?.describePersistence();
          await options.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.(
            {
              hook_event_name: "UserPromptSubmit",
              session_id: sessionId,
              transcript_path: transcriptPath,
              cwd,
              prompt: "record transcript",
            },
            undefined,
            { signal: new AbortController().signal },
          );
        }
        delivered += 1;
        return nextEvent();
      };
      return query;
    });

    try {
      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        queryFactory,
        resolveBinary: async () => "/test/claude/bin",
      });
      session = await client.createSession({
        provider: "claude",
        cwd,
        providerOptions: { allowedTools: ["Read"] },
      });
      await session.run("record transcript");
      const handle = session.describePersistence();
      await session.close();
      expect(handle?.metadata?.transcriptPath).toBe(transcriptPath);
      expect(handle?.metadata).not.toHaveProperty("providerOptions");

      const resumed = await client.resumeSession({
        provider: "claude",
        sessionId,
        metadata: handle?.metadata,
      });
      expect(await readHistoryTexts(resumed)).toEqual(["History from reported transcript"]);
      await resumed.close();
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  test.each([
    {
      recorded: "a transcript that no longer exists",
      record: async (configDir: string, sessionId: string) =>
        path.join(configDir, "moved", "projects", "project", `${sessionId}.jsonl`),
    },
    {
      recorded: "another session's transcript",
      record: (configDir: string) =>
        writeTranscript({
          transcriptPath: path.join(
            claudeProjectDirSync(process.cwd(), { configDir }),
            "other-session.jsonl",
          ),
          sessionId: "other-session",
          cwd: process.cwd(),
          text: "Other session history",
        }),
    },
    {
      recorded: "a file outside a Claude projects directory",
      record: (configDir: string, sessionId: string) =>
        writeTranscript({
          transcriptPath: path.join(configDir, "exports", `${sessionId}.jsonl`),
          sessionId,
          cwd: process.cwd(),
          text: "Exported history",
        }),
    },
  ])(
    "falls back to the configured directory when the handle records $recorded",
    async ({ record }) => {
      const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-fallback-"));
      const cwd = process.cwd();
      const sessionId = "configured-fallback-session";
      await writeTranscript({
        transcriptPath: path.join(claudeProjectDirSync(cwd, { configDir }), `${sessionId}.jsonl`),
        sessionId,
        cwd,
        text: "History from configured directory",
      });
      const transcriptPath = await record(configDir, sessionId);

      try {
        const client = new ClaudeAgentClient({
          logger: createTestLogger(),
          runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir } },
          resolveBinary: async () => "/test/claude/bin",
        });
        const session = await client.resumeSession({
          provider: "claude",
          sessionId,
          metadata: { cwd, transcriptPath },
        });
        expect(await readHistoryTexts(session)).toEqual(["History from configured directory"]);
        await session.close();
      } finally {
        await fs.rm(configDir, { recursive: true, force: true });
      }
    },
  );

  test("finds history in another project directory when the recorded transcript is missing", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-other-project-"));
    const originalCwd = path.join(configDir, "original-project");
    const resumedCwd = path.join(configDir, "resumed-project");
    const sessionId = "other-project-fallback-session";

    try {
      await fs.mkdir(originalCwd);
      await fs.mkdir(resumedCwd);
      await writeTranscript({
        transcriptPath: path.join(
          claudeProjectDirSync(originalCwd, { configDir }),
          `${sessionId}.jsonl`,
        ),
        sessionId,
        cwd: originalCwd,
        text: "History from original project directory",
      });
      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir } },
        resolveBinary: async () => "/test/claude/bin",
      });
      const session = await client.resumeSession({
        provider: "claude",
        sessionId,
        metadata: {
          cwd: resumedCwd,
          transcriptPath: path.join(
            configDir,
            "moved",
            "projects",
            "project",
            `${sessionId}.jsonl`,
          ),
        },
      });
      try {
        expect(await readHistoryTexts(session)).toEqual([
          "History from original project directory",
        ]);
      } finally {
        await session.close();
      }
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  test("forwards launch-context env through Claude process env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    let capturedPerTaskStopAffordance: boolean | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000201",
        PASEO_TEST_FLAG: "launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      capturedPerTaskStopAffordance = options.perTaskStopAffordance;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "managed-agent-env-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      runtimeSettings: {
        env: {
          MCP_TIMEOUT: "claude-startup-timeout",
          MCP_TOOL_TIMEOUT: "claude-tool-timeout",
        },
      },
    });
    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const result = await session.run("env check");
      expect(result.sessionId).toBe("managed-agent-env-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
      expect(capturedEnv?.MCP_TIMEOUT).toBe("claude-startup-timeout");
      expect(capturedEnv?.MCP_TOOL_TIMEOUT).toBe("claude-tool-timeout");
      expect(session.usageSession?.()?.env).toBe(capturedEnv);
      // Paseo reads session_state_changed to know when an autonomous turn is over.
      expect(capturedEnv?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
      // Without it, Stop and replace kill every background subagent along with the turn.
      expect(capturedPerTaskStopAffordance).toBe(true);
    } finally {
      await session.close();
      expect(session.usageSession?.()).toBeNull();
    }
  });

  test("forwards launch-context env through Claude resume env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000202",
        PASEO_TEST_FLAG: "resume-launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "persisted-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.resumeSession(
      {
        provider: "claude",
        sessionId: "persisted-session",
        metadata: {
          cwd: process.cwd(),
        },
      },
      {
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const descriptor = session.usageSession?.();
      expect(descriptor?.env.PASEO_TEST_FLAG).toBe("resume-launch-value");
      expect(descriptor?.sessionKey).toEqual(expect.any(String));
      expect(queryFactory).not.toHaveBeenCalled();
      const result = await session.run("resume env check");
      expect(session.usageSession?.()?.sessionKey).toBe(descriptor?.sessionKey);
      expect(capturedEnv).toBe(descriptor?.env);
      expect(result.sessionId).toBe("persisted-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
    } finally {
      await session.close();
      expect(session.usageSession?.()).toBeNull();
    }
  });
});
