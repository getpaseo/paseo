import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClaudeAgentClient } from "./claude-agent.js";
import type { AgentSessionConfig, AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-agent-e2e-"));
  return dir;
}

async function autoApprove(session: Awaited<ReturnType<ClaudeAgentClient["createSession"]>>, event: AgentStreamEvent) {
  if (event.type === "permission_requested") {
    await session.respondToPermission(event.request.id, { behavior: "allow" });
  }
}

describe("ClaudeAgentClient (SDK integration)", () => {
  test(
    "responds with text",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 1024 } },
      };
      const session = await client.createSession(config);

      const result = await session.run(
        "Reply with the single word ACK and then stop."
      );

      expect(result.finalText.toLowerCase()).toContain("ack");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "streams reasoning chunks",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 2048 } },
      };
      const session = await client.createSession(config);

      const events = session.stream(
        "Think step by step about the pros and cons of single-file tests, but only share a short plan."
      );

      let sawReasoning = false;

      for await (const event of events) {
        await autoApprove(session, event);
        if (event.type === "timeline" && event.item.type === "reasoning") {
          sawReasoning = true;
        }
        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }

      expect(sawReasoning).toBe(true);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "tracks permission + tool lifecycle when editing a file",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 1024 } },
      };
      const session = await client.createSession(config);

      const events = session.stream(
        "First run a Bash command to print the working directory, then use your editor tools (not the shell) to create a file named tool-test.txt in the current directory that contains exactly the text 'hello world'. Report 'done' after the write finishes."
      );

      const timeline: AgentTimelineItem[] = [];
      let completed = false;

      for await (const event of events) {
        await autoApprove(session, event);
        if (event.type === "timeline") {
          timeline.push(event.item);
        }
        if (event.type === "turn_completed") {
          completed = true;
          break;
        }
        if (event.type === "turn_failed") {
          break;
        }
      }

      const toolCalls = timeline.filter(
        (item): item is Extract<AgentTimelineItem, { type: "tool_call" }> =>
          item.type === "tool_call"
      );
      const commandEvents = toolCalls.filter(
        (item) =>
          (item.kind === "execute" || item.server === "command") &&
          typeof item.displayName === "string" &&
          !item.displayName.startsWith("permission:")
      );
      const fileChangeEvent = toolCalls.find((item) => {
        if (!item.output || typeof item.output !== "object") {
          return false;
        }
        const files = (item.output as Record<string, unknown>).files;
        if (!Array.isArray(files)) {
          return false;
        }
        return files.some((file) => typeof file?.path === "string" && file.path.includes("tool-test.txt"));
      });

      const sawPwdCommand = commandEvents.some(
        (item) => (item.displayName ?? "").toLowerCase().includes("pwd") && item.status === "completed"
      );

      expect(completed).toBe(true);
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(sawPwdCommand).toBe(true);
      expect(fileChangeEvent).toBeTruthy();

      const filePath = path.join(cwd, "tool-test.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toContain("hello world");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    180_000
  );

  test(
    "supports multi-turn conversations",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 2048 } },
      };
      const session = await client.createSession(config);

      const first = await session.run("Respond only with the word alpha.");
      expect(first.finalText.toLowerCase()).toContain("alpha");

      const second = await session.run(
        "Without adding any explanations, repeat exactly the same word you just said."
      );
      expect(second.finalText.toLowerCase()).toContain("alpha");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "resumes a persisted session",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 1024 } },
      };
      const session = await client.createSession(config);

      const first = await session.run("Say READY and then stop.");
      expect(first.finalText.toLowerCase()).toContain("ready");

      const handle = session.describePersistence();
      expect(handle).toBeTruthy();

      await session.close();

      const resumed = await client.resumeSession(handle!, { cwd });
      const resumedResult = await resumed.run(
        "Respond with the single word RESUMED."
      );
      expect(resumedResult.finalText.toLowerCase()).toContain("resumed");
      await resumed.close();

      rmSync(cwd, { recursive: true, force: true });
    },
    150_000
  );

  test(
    "updates session modes",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 1024 } },
      };
      const session = await client.createSession(config);

      const modes = await session.getAvailableModes();
      expect(modes.map((m) => m.id)).toContain("plan");

      await session.setMode("plan");
      expect(await session.getCurrentMode()).toBe("plan");

      const result = await session.run(
        "Just reply with the word PLAN to confirm you're still responsive."
      );
      expect(result.finalText.toLowerCase()).toContain("plan");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "handles plan mode approval flow",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 2048 } },
      };
      const session = await client.createSession(config);
      await session.setMode("plan");

      const events = session.stream(
        "Devise a plan to create a file named dummy.txt containing the word plan-test. After planning, proceed to execute your plan."
      );

      let sawPlan = false;
      for await (const event of events) {
        await autoApprove(session, event);
        if (
          event.type === "timeline" &&
          event.item.type === "todo" &&
          event.item.items.some((entry) => entry.text.includes("dummy.txt"))
        ) {
          sawPlan = true;
        }

        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }

      expect(sawPlan).toBe(true);
      expect(await session.getCurrentMode()).toBe("acceptEdits");

      const filePath = path.join(cwd, "dummy.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toContain("plan-test");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    180_000
  );
});
