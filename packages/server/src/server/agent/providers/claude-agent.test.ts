import { describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClaudeAgentClient, convertClaudeHistoryEntry } from "./claude-agent.js";
import {
  hydrateStreamState,
  type StreamItem,
  type AgentToolCallData,
  isAgentToolCallItem,
} from "../../../../../app/src/types/stream.js";
import type { AgentStreamEventPayload } from "../../messages.js";
import type {
  AgentProvider,
  AgentPermissionRequest,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const claudeIntegrationEnabled =
  process.env.RUN_CLAUDE_AGENT_TESTS === "1" || Boolean(process.env.ANTHROPIC_API_KEY?.trim()?.length);
const describeClaudeIntegration = claudeIntegrationEnabled ? describe : describe.skip;

if (!claudeIntegrationEnabled) {
  console.warn(
    "Skipping ClaudeAgentClient integration tests. Set RUN_CLAUDE_AGENT_TESTS=1 and provide ANTHROPIC_API_KEY to enable them."
  );
}

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-agent-e2e-"));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

async function autoApprove(session: Awaited<ReturnType<ClaudeAgentClient["createSession"]>>, event: AgentStreamEvent) {
  if (event.type === "permission_requested") {
    await session.respondToPermission(event.request.id, { behavior: "allow" });
  }
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function extractCommandText(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const command = (input as { command?: unknown }).command;
  if (typeof command === "string" && command.length > 0) {
    return command;
  }
  if (Array.isArray(command)) {
    const tokens = command.filter((value): value is string => typeof value === "string");
    if (tokens.length > 0) {
      return tokens.join(" ");
    }
  }
  if (typeof (input as { description?: string }).description === "string") {
    const description = (input as { description?: string }).description as string;
    if (description.length > 0) {
      return description;
    }
  }
  return null;
}

function isSleepCommandToolCall(item: ToolCallItem): boolean {
  const display = typeof item.displayName === "string" ? item.displayName.toLowerCase() : "";
  if (display.includes("sleep 60")) {
    return true;
  }
  const inputCommand = extractCommandText(item.input)?.toLowerCase() ?? "";
  return inputCommand.includes("sleep 60");
}

function isPermissionCommandToolCall(item: ToolCallItem): boolean {
  if (item.server === "permission") {
    return false;
  }
  const display = typeof item.displayName === "string" ? item.displayName.toLowerCase() : "";
  const inputCommand = extractCommandText(item.input)?.toLowerCase() ?? "";
  return display.includes("permission.txt") || inputCommand.includes("permission.txt");
}

describeClaudeIntegration("ClaudeAgentClient (SDK integration)", () => {
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

      const marker = "CLAUDE_ACK_TOKEN";
      const result = await session.run(
        `Reply with the exact text ${marker} and then stop.`
      );

      expect(result.finalText).toContain(marker);

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
    "emits a single assistant message in the hydrated stream",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 2048 } },
      };
      const session = await client.createSession(config);
      const updates: StreamHydrationUpdate[] = [];

      try {
        const events = session.stream("Reply with the exact words HELLO WORLD.");
        for await (const event of events) {
          await autoApprove(session, event);
          recordTimelineUpdate(updates, event);
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }
      } finally {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      }

      const state = hydrateStreamState(updates);
      const assistantMessages = state.filter(
        (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
          item.kind === "assistant_message"
      );
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text.toLowerCase()).toContain("hello world");
    },
    150_000
  );

  test(
    "shows the command inside pending tool calls",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 2048 } },
      };
      const session = await client.createSession(config);

      let pendingDisplay: string | null = null;
      const events = session.stream("Run the exact command `pwd` via Bash and stop.");

      try {
        for await (const event of events) {
          await autoApprove(session, event);
          if (
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.server.toLowerCase().includes("bash") &&
            event.item.status === "pending"
          ) {
            pendingDisplay = event.item.displayName ?? null;
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }
      } finally {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      }

      expect(pendingDisplay).toBeTruthy();
      expect(pendingDisplay?.toLowerCase()).toContain("pwd");
    },
    150_000
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
        // Check for file changes in structured output.files array
        if (item.output && typeof item.output === "object") {
          const files = (item.output as Record<string, unknown>).files;
          if (Array.isArray(files) && files.some((file) => typeof file?.path === "string" && file.path.includes("tool-test.txt"))) {
            return true;
          }
        }
        // Also check for file path in output structure (write/edit tools)
        if (item.output && typeof item.output === "object") {
          const output = item.output as Record<string, unknown>;
          if (output.type === "file_write" || output.type === "file_edit") {
            const filePath = output.filePath;
            if (typeof filePath === "string" && filePath.includes("tool-test.txt")) {
              return true;
            }
          }
        }
        return false;
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
    "permission flow parity - allows command after approval",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        modeId: "default",
        extra: { claude: { maxThinkingTokens: 1024 } },
      };
      const session = await client.createSession(config);
      const filePath = path.join(cwd, "permission.txt");

      let captured: AgentPermissionRequest | null = null;
      let sawResolvedAllow = false;
      const timeline: AgentTimelineItem[] = [];

      try {
        const prompt = [
          "Request approval to run the command `printf \"ok\" > permission.txt` using Bash.",
          "After approval, run it and reply DONE.",
        ].join(" ");

        for await (const event of session.stream(prompt)) {
          if (event.type === "permission_requested" && !captured) {
            captured = event.request;
            expect(session.getPendingPermissions().length).toBeGreaterThan(0);
            await session.respondToPermission(captured.id, { behavior: "allow" });
          }
          if (
            event.type === "permission_resolved" &&
            captured &&
            event.requestId === captured.id &&
            event.resolution.behavior === "allow"
          ) {
            sawResolvedAllow = true;
          }
          if (event.type === "timeline") {
            timeline.push(event.item);
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }
      } finally {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      }

      expect(captured).not.toBeNull();
      expect(sawResolvedAllow).toBe(true);
      expect(session.getPendingPermissions()).toHaveLength(0);
      expect(
        timeline.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "granted"
        )
      ).toBe(true);
      expect(
        timeline.some(
          (item) =>
            item.type === "tool_call" &&
            isPermissionCommandToolCall(item) &&
            item.status === "completed"
        )
      ).toBe(true);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toContain("ok");
    },
    180_000
  );

  test(
    "permission flow parity - denies command execution",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        modeId: "default",
        extra: { claude: { maxThinkingTokens: 1024 } },
      };
      const session = await client.createSession(config);
      const filePath = path.join(cwd, "permission.txt");

      let captured: AgentPermissionRequest | null = null;
      let sawResolvedDeny = false;
      const timeline: AgentTimelineItem[] = [];

      try {
        const prompt = [
          "Request approval to run the command `printf \"ok\" > permission.txt` using Bash.",
          "If approval is denied, reply DENIED and stop.",
        ].join(" ");

        for await (const event of session.stream(prompt)) {
          if (event.type === "permission_requested" && !captured) {
            captured = event.request;
            await session.respondToPermission(captured.id, {
              behavior: "deny",
              message: "Not allowed.",
            });
          }
          if (
            event.type === "permission_resolved" &&
            captured &&
            event.requestId === captured.id &&
            event.resolution.behavior === "deny"
          ) {
            sawResolvedDeny = true;
          }
          if (event.type === "timeline") {
            timeline.push(event.item);
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }
      } finally {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      }

      expect(captured).not.toBeNull();
      expect(sawResolvedDeny).toBe(true);
      expect(
        timeline.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "denied"
        )
      ).toBe(true);
      expect(
        timeline.some(
          (item) =>
            item.type === "tool_call" &&
            isPermissionCommandToolCall(item) &&
            item.status === "completed"
        )
      ).toBe(false);
      expect(existsSync(filePath)).toBe(false);
    },
    180_000
  );

  test(
    "permission flow parity - aborts on interrupt response",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        modeId: "default",
        extra: { claude: { maxThinkingTokens: 1024 } },
      };
      const session = await client.createSession(config);
      const filePath = path.join(cwd, "permission.txt");

      let captured: AgentPermissionRequest | null = null;
      let sawResolvedInterrupt = false;
      let sawTerminalEvent = false;
      const timeline: AgentTimelineItem[] = [];

      try {
        const prompt = [
          "Request approval to run the command `printf \"ok\" > permission.txt` using Bash.",
          "If approval is denied, stop immediately.",
        ].join(" ");

        for await (const event of session.stream(prompt)) {
          if (event.type === "permission_requested" && !captured) {
            captured = event.request;
            await session.respondToPermission(captured.id, {
              behavior: "deny",
              message: "Stop now.",
              interrupt: true,
            });
          }
          if (
            event.type === "permission_resolved" &&
            captured &&
            event.requestId === captured.id &&
            event.resolution.behavior === "deny" &&
            event.resolution.interrupt
          ) {
            sawResolvedInterrupt = true;
          }
          if (event.type === "timeline") {
            timeline.push(event.item);
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            sawTerminalEvent = true;
            break;
          }
        }
      } finally {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      }

      expect(captured).not.toBeNull();
      expect(sawResolvedInterrupt).toBe(true);
      expect(sawTerminalEvent).toBe(true);
      expect(
        timeline.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "denied"
        )
      ).toBe(true);
      expect(
        timeline.some(
          (item) =>
            item.type === "tool_call" &&
            isPermissionCommandToolCall(item) &&
            item.status === "completed"
        )
      ).toBe(false);
      expect(existsSync(filePath)).toBe(false);
    },
    180_000
  );

  test(
    "interrupts a long-running bash command before it finishes",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 2048 } },
      };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      let runStartedAt: number | null = null;
      let durationMs = 0;
      let sawSleepCommand = false;
      let interruptIssued = false;

      try {
        session = await client.createSession(config);
        const prompt = [
          "Use your Bash command tool to run the exact command `sleep 60`.",
          "Do not run any other commands or respond until that command finishes.",
        ].join(" ");

        runStartedAt = Date.now();
        const events = session.stream(prompt);

        for await (const event of events) {
          await autoApprove(session, event);

          if (event.type === "timeline" && event.item.type === "tool_call" && isSleepCommandToolCall(event.item)) {
            sawSleepCommand = true;
            if (!interruptIssued) {
              interruptIssued = true;
              await session.interrupt();
            }
          }

          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        if (runStartedAt === null) {
          throw new Error("Claude run never started");
        }
        durationMs = Date.now() - runStartedAt;
      } finally {
        if (durationMs === 0 && runStartedAt !== null) {
          durationMs = Date.now() - runStartedAt;
        }
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
      }

      expect(sawSleepCommand).toBe(true);
      expect(interruptIssued).toBe(true);
      expect(durationMs).toBeGreaterThan(0);
      expect(durationMs).toBeLessThan(60_000);
    },
    120_000
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

  test(
    "hydrates persisted tool call results into the UI stream",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 4096 } },
      };
      const session = await client.createSession(config);
      const prompt = [
        "You are verifying the hydrate regression test.",
        "Follow these steps exactly and report 'hydration test complete' at the end:",
        "1. Run the Bash command 'pwd' via the terminal tool.",
        "2. Use your editor tools (not the shell) to create a file named hydrate-proof.txt with the content:",
        "   HYDRATION_PROOF_LINE_ONE",
        "   HYDRATION_PROOF_LINE_TWO",
        "3. Read hydrate-proof.txt via the editor read_file tool to confirm the contents.",
        "4. Summarize the diff/write results briefly and then stop.",
      ].join("\n");

      try {
        const liveTimelineUpdates: StreamHydrationUpdate[] = [];
        const events = session.stream(prompt);

        let completed = false;
        try {
          for await (const event of events) {
            await autoApprove(session, event);
            recordTimelineUpdate(liveTimelineUpdates, event);
            if (event.type === "turn_completed") {
              completed = true;
              break;
            }
            if (event.type === "turn_failed") {
              throw new Error(event.error);
            }
          }
        } finally {
          await session.close();
        }

        expect(completed).toBe(true);
        const liveState = hydrateStreamState(liveTimelineUpdates);
        const liveSnapshots = extractAgentToolSnapshots(liveState);
        const commandTool = liveSnapshots.find((snapshot) =>
          (snapshot.data.displayName ?? "").toLowerCase().includes("pwd")
        );
        const editTool = liveSnapshots.find((snapshot) =>
          rawContainsText(snapshot.data.result, "hydrate-proof.txt")
        );
        const readTool = liveSnapshots.find((snapshot) =>
          rawContainsText(snapshot.data.result, "HYDRATION_PROOF_LINE_TWO")
        );

        expect(commandTool).toBeTruthy();
        expect(editTool).toBeTruthy();
        expect(readTool).toBeTruthy();

        const handle = session.describePersistence();
        expect(handle).toBeTruthy();
        const sessionId = handle?.sessionId ?? handle?.nativeHandle;
        expect(typeof sessionId).toBe("string");

        const historyPaths = getClaudeHistoryPaths(cwd, sessionId!);
        expect(await waitForHistoryFile(historyPaths)).toBe(true);

        const resumed = await client.resumeSession(handle!, { cwd });
        const hydrationUpdates: StreamHydrationUpdate[] = [];
        try {
          for await (const event of resumed.streamHistory()) {
            recordTimelineUpdate(hydrationUpdates, event);
          }
        } finally {
          await resumed.close();
        }

        expect(hydrationUpdates.length).toBeGreaterThan(0);

        const hydratedState = hydrateStreamState(hydrationUpdates);
        const hydratedSnapshots = extractAgentToolSnapshots(hydratedState);
        const hydratedMap = new Map(
          hydratedSnapshots.map((entry) => [entry.key, entry.data])
        );

        assertHydratedReplica(
          commandTool!,
          hydratedMap,
          (data) =>
            rawContainsText(data.result, cwd),
          ({ live, hydrated }) => {
            expect(rawContainsText(live.result, cwd)).toBe(true);
            expect(rawContainsText(hydrated.result, cwd)).toBe(true);
            expect((live.displayName ?? "").toLowerCase()).toContain("pwd");
            expect((hydrated.displayName ?? "").toLowerCase()).toContain("pwd");
          }
        );
        assertHydratedReplica(
          editTool!,
          hydratedMap,
          (data) =>
            (data.result as any)?.type === "file_write" &&
            typeof (data.result as any)?.filePath === "string" &&
            ((data.result as any).filePath as string).includes("hydrate-proof.txt"),
          ({ live, hydrated }) => {
            const liveDiff = JSON.stringify(live.result ?? {});
            const hydratedDiff = JSON.stringify(hydrated.result ?? {});
            expect(liveDiff).toContain("hydrate-proof.txt");
            expect(hydratedDiff).toContain("hydrate-proof.txt");
          }
        );
        assertHydratedReplica(
          readTool!,
          hydratedMap,
          (data) =>
            rawContainsText(data.result, "HYDRATION_PROOF_LINE_ONE") &&
            rawContainsText(data.result, "HYDRATION_PROOF_LINE_TWO"),
          ({ live, hydrated }) => {
            const liveReads = JSON.stringify(live.result ?? {});
            const hydratedReads = JSON.stringify(hydrated.result ?? {});
            expect(liveReads).toContain("HYDRATION_PROOF_LINE_ONE");
            expect(hydratedReads).toContain("HYDRATION_PROOF_LINE_ONE");
            expect(liveReads).toContain("HYDRATION_PROOF_LINE_TWO");
            expect(hydratedReads).toContain("HYDRATION_PROOF_LINE_TWO");
          }
        );
      } finally {
        cleanupClaudeHistory(cwd);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    240_000
  );

  test(
    "hydrates user messages from persisted history",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient();
      const config: AgentSessionConfig = {
        provider: "claude",
        cwd,
        extra: { claude: { maxThinkingTokens: 1024 } },
      };

      const promptMarker = `HYDRATED_USER_${Date.now().toString(36)}`;
      const prompt = `Reply with the exact text ${promptMarker} and then stop.`;
      const liveTimelineUpdates: StreamHydrationUpdate[] = [
        buildUserMessageUpdate("claude", prompt, "msg-claude-hydrated-user"),
      ];

      try {
        const session = await client.createSession(config);
        const events = session.stream(prompt);
        try {
          for await (const event of events) {
            recordTimelineUpdate(liveTimelineUpdates, event);
            if (event.type === "turn_completed" || event.type === "turn_failed") {
              break;
            }
          }
        } finally {
          await session.close();
        }

        const handle = session.describePersistence();
        expect(handle).toBeTruthy();
        const sessionId = handle?.sessionId ?? handle?.nativeHandle;
        expect(typeof sessionId).toBe("string");

        const historyPaths = getClaudeHistoryPaths(cwd, sessionId!);
        expect(await waitForHistoryFile(historyPaths)).toBe(true);

        const resumed = await client.resumeSession(handle!, { cwd });
        const hydrationUpdates: StreamHydrationUpdate[] = [];
        try {
          for await (const event of resumed.streamHistory()) {
            recordTimelineUpdate(hydrationUpdates, event);
          }
        } finally {
          await resumed.close();
        }

        const liveState = hydrateStreamState(liveTimelineUpdates);
        const hydratedState = hydrateStreamState(hydrationUpdates);

        expect(stateIncludesUserMessage(liveState, promptMarker)).toBe(true);
        expect(stateIncludesUserMessage(hydratedState, promptMarker)).toBe(true);
      } finally {
        cleanupClaudeHistory(cwd);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    240_000
  );
});

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
      } as AgentTimelineItem,
    ];

    const mapBlocks = vi.fn().mockReturnValue(stubTimeline);
    const result = convertClaudeHistoryEntry(entry, mapBlocks);

    expect(result).toEqual(stubTimeline);
    expect(mapBlocks).toHaveBeenCalledTimes(1);
    const arg = mapBlocks.mock.calls[0][0];
    expect(Array.isArray(arg)).toBe(true);
  });

  test("returns user messages when no tool blocks exist", () => {
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: "Run npm test",
      },
    };

    const result = convertClaudeHistoryEntry(entry, () => []);

    expect(result).toEqual([
      {
        type: "user_message",
        text: "Run npm test",
      },
    ]);
  });
});

type StreamHydrationUpdate = {
  event: Extract<AgentStreamEventPayload, { type: "timeline" }>;
  timestamp: Date;
};

type ToolSnapshot = { key: string; data: AgentToolCallData };

function recordTimelineUpdate(target: StreamHydrationUpdate[], event: AgentStreamEvent) {
  if (event.type !== "timeline") {
    return;
  }
  const payload = event as Extract<AgentStreamEvent, { type: "timeline" }>;
  target.push({
    event: payload as StreamHydrationUpdate["event"],
    timestamp: new Date(),
  });
}

function buildUserMessageUpdate(
  provider: AgentProvider,
  text: string,
  messageId: string
): StreamHydrationUpdate {
  return {
    event: {
      type: "timeline",
      provider,
      item: {
        type: "user_message",
        text,
        messageId,
      },
    },
    timestamp: new Date(),
  };
}

function stateIncludesUserMessage(state: StreamItem[], marker: string): boolean {
  return state.some(
    (item) => item.kind === "user_message" && item.text.toLowerCase().includes(marker.toLowerCase())
  );
}

function extractAgentToolSnapshots(state: StreamItem[]): ToolSnapshot[] {
  return state.filter(isAgentToolCallItem).map((item) => ({
    key: buildToolSnapshotKey(item.payload.data, item.id),
    data: item.payload.data,
  }));
}

function buildToolSnapshotKey(data: AgentToolCallData, fallbackId: string): string {
  const normalized = typeof data.callId === "string" && data.callId.trim().length > 0 ? data.callId.trim() : null;
  if (normalized) {
    return normalized;
  }
  const display = typeof data.displayName === "string" && data.displayName.trim().length > 0 ? data.displayName.trim() : fallbackId;
  return `${data.server}:${data.tool}:${display}`;
}

function assertHydratedReplica(
  liveSnapshot: ToolSnapshot,
  hydratedMap: Map<string, AgentToolCallData>,
  predicate: (data: AgentToolCallData) => boolean,
  extraAssertions?: (ctx: { live: AgentToolCallData; hydrated: AgentToolCallData }) => void
) {
  expect(predicate(liveSnapshot.data)).toBe(true);
  const hydrated = hydratedMap.get(liveSnapshot.key);
  expect(hydrated).toBeTruthy();
  expect(hydrated?.status).toBe(liveSnapshot.data.status);
  expect(hydrated?.server).toBe(liveSnapshot.data.server);
  expect(hydrated?.tool).toBe(liveSnapshot.data.tool);
  expect(hydrated?.displayName).toBe(liveSnapshot.data.displayName);
  expect(predicate(hydrated!)).toBe(true);
  if (hydrated && extraAssertions) {
    extraAssertions({ live: liveSnapshot.data, hydrated });
  }
}

function sanitizeClaudeProjectName(cwd: string): string {
  return cwd.replace(/[\\/]/g, "-").replace(/_/g, "-");
}

function resolveClaudeHistoryPath(cwd: string, sessionId: string): string {
  const sanitized = sanitizeClaudeProjectName(cwd);
  return path.join(os.homedir(), ".claude", "projects", sanitized, `${sessionId}.jsonl`);
}

function getClaudeHistoryPaths(cwd: string, sessionId: string): string[] {
  return normalizeCwdCandidates(cwd).map((candidate) =>
    resolveClaudeHistoryPath(candidate, sessionId)
  );
}

function normalizeCwdCandidates(cwd: string): string[] {
  const candidates = new Set<string>([cwd]);
  try {
    const resolved = realpathSync(cwd);
    candidates.add(resolved);
  } catch {
    // ignore resolution errors
  }
  return Array.from(candidates);
}

function cleanupClaudeHistory(cwd: string) {
  for (const candidate of normalizeCwdCandidates(cwd)) {
    const sanitized = sanitizeClaudeProjectName(candidate);
    const projectDir = path.join(os.homedir(), ".claude", "projects", sanitized);
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }
}

async function waitForHistoryFile(historyPaths: string | string[], timeoutMs = 10_000): Promise<boolean> {
  const candidates = Array.isArray(historyPaths) ? Array.from(new Set(historyPaths)) : [historyPaths];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (candidates.some((entry) => existsSync(entry))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return candidates.some((entry) => existsSync(entry));
}

function rawContainsText(raw: unknown, text: string, depth = 0): boolean {
  if (!raw || typeof text !== "string" || !text) {
    return false;
  }
  if (typeof raw === "string") {
    return raw.includes(text);
  }
  if (depth > 6) {
    return false;
  }
  if (Array.isArray(raw)) {
    return raw.some((entry) => rawContainsText(entry, text, depth + 1));
  }
  if (typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>).some((value) =>
      rawContainsText(value, text, depth + 1)
    );
  }
  return false;
}
