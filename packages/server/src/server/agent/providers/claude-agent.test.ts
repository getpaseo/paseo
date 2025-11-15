import { describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClaudeAgentClient, convertClaudeHistoryEntry } from "./claude-agent.js";
import { hydrateStreamState, type StreamItem, type ToolCallItem, type AgentToolCallData } from "../../../../../app/src/types/stream.js";
import type { AgentStreamEventPayload } from "../../messages.js";
import type { AgentProvider, AgentSessionConfig, AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";

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
          rawContainsText(snapshot.data.raw, "hydrate-proof.txt")
        );
        const readTool = liveSnapshots.find((snapshot) =>
          rawContainsText(snapshot.data.raw, "HYDRATION_PROOF_LINE_TWO")
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
          (data) => (data.parsedCommand?.output ?? "").includes(cwd),
          ({ live, hydrated }) => {
            expect((live.parsedCommand?.command ?? "").toLowerCase()).toContain("pwd");
            expect(live.parsedCommand?.output ?? "").toContain(cwd);
            expect((hydrated.parsedCommand?.command ?? "").toLowerCase()).toContain("pwd");
            expect(hydrated.parsedCommand?.output ?? "").toContain(cwd);
          }
        );
        assertHydratedReplica(
          editTool!,
          hydratedMap,
          (data) =>
            Array.isArray(data.parsedEdits) &&
            data.parsedEdits.some(
              (entry) =>
                (entry.filePath ?? "").includes("hydrate-proof.txt") &&
                entry.diffLines.some((line) => line.content.includes("HYDRATION_PROOF_LINE_TWO"))
            ),
          ({ live, hydrated }) => {
            const liveDiff = JSON.stringify(live.parsedEdits ?? []);
            const hydratedDiff = JSON.stringify(hydrated.parsedEdits ?? []);
            expect(liveDiff).toContain("HYDRATION_PROOF_LINE_ONE");
            expect(liveDiff).toContain("HYDRATION_PROOF_LINE_TWO");
            expect(hydratedDiff).toContain("HYDRATION_PROOF_LINE_ONE");
            expect(hydratedDiff).toContain("HYDRATION_PROOF_LINE_TWO");
          }
        );
        assertHydratedReplica(
          readTool!,
          hydratedMap,
          (data) =>
            Array.isArray(data.parsedReads) &&
            data.parsedReads.some(
              (entry) =>
                (entry.filePath ?? "").includes("hydrate-proof.txt") &&
                entry.content.includes("HYDRATION_PROOF_LINE_TWO")
            ),
          ({ live, hydrated }) => {
            const liveReads = JSON.stringify(live.parsedReads ?? []);
            const hydratedReads = JSON.stringify(hydrated.parsedReads ?? []);
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
        raw: entry.message,
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
  return state
    .filter(
      (item): item is ToolCallItem =>
        item.kind === "tool_call" && item.payload.source === "agent"
    )
    .map((item) => ({
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
