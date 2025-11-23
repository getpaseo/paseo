import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAgentClient, isSyntheticRolloutUserMessage } from "./codex-agent.js";
import {
  hydrateStreamState,
  isAgentToolCallItem,
  type AgentToolCallItem,
  type StreamItem,
} from "../../../../../app/src/types/stream.js";
import {
  serializeAgentStreamEvent,
  type AgentStreamEventPayload,
} from "../../messages.js";
import type {
  AgentProvider,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(os.tmpdir(), "codex-agent-e2e-"));
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

function log(message: string): void {
  console.info(`[CodexAgentTest] ${message}`);
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function commandTextFromInput(input: unknown): string | null {
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
  return null;
}

function isSleepCommandToolCall(item: ToolCallItem): boolean {
  const display = typeof item.displayName === "string" ? item.displayName.toLowerCase() : "";
  if (display.includes("sleep 60")) {
    return true;
  }
  const inputText = commandTextFromInput(item.input)?.toLowerCase() ?? "";
  return inputText.includes("sleep 60");
}

describe("CodexAgentClient (SDK integration)", () => {
  test(
    "responds with text",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd, modeId: "full-access" };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Running single-turn acknowledgment test");

        const result = await session.run("Reply with the single word ACK and then stop.");

        expect(result.finalText.toLowerCase()).toContain("ack");
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    120_000
  );

  test(
    "emits tool or command events when writing a file",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Streaming file creation activity");

        const events = session.stream(
          "Create a file named tool-test.txt in the current directory with the contents 'hello world', then stop."
        );

        let sawActivity = false;

        for await (const event of events) {
          if (
            event.type === "timeline" &&
            event.provider === "codex" &&
            event.item.type === "tool_call"
          ) {
            sawActivity = true;
          }
          if (
            event.type === "provider_event" &&
            event.provider === "codex" &&
            event.raw?.type &&
            event.raw.type.startsWith("item") &&
            ["file_change", "command_execution", "mcp_tool_call"].includes((event.raw as any).item?.type)
          ) {
            sawActivity = true;
          }

          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(sawActivity).toBe(true);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "emits Codex tool calls that hydrate into specific UI entries",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd };
      type HydrationEntry = { event: AgentStreamEventPayload; timestamp: Date };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Streaming Codex run for tool call hydration test");

        const hydrationUpdates: HydrationEntry[] = [];
        const stream = session.stream(
          [
            "1. Run the command `pwd` using your shell tool and report the output.",
            "2. Next, use your apply_patch editing tool (not the shell) to create a file named codex-stream.log containing exactly the single line 'ok'.",
            "3. After the patch succeeds, stop.",
          ].join("\n")
        );

        for await (const event of stream) {
          if (event.type === "timeline" || event.type === "provider_event") {
            hydrationUpdates.push({
              event: serializeAgentStreamEvent(event),
              timestamp: new Date(),
            });
          }

          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        const streamItems = hydrateStreamState(hydrationUpdates);
        const commandEntry = streamItems.find(
          (item): item is AgentToolCallItem =>
            isAgentToolCallItem(item) &&
            item.payload.data.server === "command" &&
            (item.payload.data.displayName?.includes("pwd") ?? false)
        );
        const fileEntry = streamItems.find((item): item is AgentToolCallItem => {
          if (!isAgentToolCallItem(item)) {
            return false;
          }
          if (item.payload.data.server !== "file_change") {
            return false;
          }
          const result = item.payload.data.result as { files?: Array<{ path?: string }> } | undefined;
          if (!Array.isArray(result?.files)) {
            return false;
          }
          return result.files.some((file) => typeof file?.path === "string" && file.path.includes("codex-stream.log"));
        });

        expect(commandEntry).toBeDefined();
        expect(commandEntry?.payload.data.status).toBe("completed");
        expect(commandEntry?.payload.data.result).toMatchObject({
          exitCode: 0,
        });

        expect(fileEntry).toBeDefined();
        expect(fileEntry?.payload.data.status).toBe("completed");
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "hydrates persisted shell_command tool calls with completed status",
    async () => {
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const cwd = tmpCwd();
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      let resumed: Awaited<ReturnType<typeof client.resumeSession>> | null = null;
      try {
        session = await client.createSession({ provider: "codex", cwd, modeId: "full-access" });
        log("Recording Codex command activity for persistence hydration test");

        const prompt = [
          "Run the command `pwd` using your shell tool to print the working directory.",
          "After the command finishes, respond with DONE and stop.",
        ].join("\n");

        let sawCommand = false;
        const stream = session.stream(prompt);
        for await (const event of stream) {
          if (
            event.type === "timeline" &&
            event.provider === "codex" &&
            event.item.type === "tool_call" &&
            event.item.server === "command"
          ) {
            sawCommand = true;
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }
        expect(sawCommand).toBe(true);

        const handle = session.describePersistence();
        expect(handle).toBeTruthy();

        await session.close();
        session = null;

        const rolloutPath = handle ? await resolveRolloutPathFromHandle(handle) : null;
        expect(rolloutPath).toBeTruthy();
        await prependSyntheticRolloutEntries(rolloutPath!, [
          buildSyntheticInstructionEntry(handle!.sessionId ?? handle!.nativeHandle ?? "synthetic-session"),
          buildSyntheticEnvironmentEntry(),
        ]);

        resumed = await client.resumeSession(handle!);
        const hydrationUpdates: StreamHydrationUpdate[] = [];
        for await (const event of resumed.streamHistory()) {
          recordTimelineUpdate(hydrationUpdates, event);
        }

        const hydratedState = hydrateStreamState(hydrationUpdates);
        const commandEntry = hydratedState.find(
          (item): item is AgentToolCallItem =>
            isAgentToolCallItem(item) && item.payload.data.server === "command"
        );
        expect(commandEntry).toBeTruthy();
        if (commandEntry) {
          expect(commandEntry.payload.data.status).toBe("completed");
          expect(commandEntry.payload.data.result).toMatchObject({
            metadata: { exit_code: 0 },
          });
        }
      } finally {
        await session?.close();
        await resumed?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "supports multiple turns within the same session",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Running multi-turn continuity test");

        const first = await session.run("Reply with the exact text ACK-ONE and then stop.");
        expect(first.finalText.toLowerCase()).toContain("ack-one");

        const handleAfterFirst = session.describePersistence();
        expect(handleAfterFirst?.sessionId).toBeTruthy();

        const second = await session.run("Now reply with another acknowledgment and then stop.");
        expect(second.finalText).not.toHaveLength(0);
        expect(second.finalText).not.toBe(first.finalText);

        const handleAfterSecond = session.describePersistence();
        expect(handleAfterSecond?.sessionId).toBe(handleAfterFirst?.sessionId);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    150_000
  );

  test(
    "can change modes mid-session",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd, modeId: "auto" };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Testing mode transitions inside a single session");

        expect(await session.getCurrentMode()).toBe("auto");

        const first = await session.run("Reply with ACK-MODE-AUTO and then stop.");
        expect(first.finalText.toLowerCase()).toContain("ack-mode-auto");

        await session.setMode("full-access");
        expect(await session.getCurrentMode()).toBe("full-access");

        const second = await session.run("Reply with ACK-MODE-FULL and then stop.");
        expect(second.finalText.toLowerCase()).toContain("ack-mode-full");
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "resumes a session using a persistence handle",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      let resumed: Awaited<ReturnType<typeof client.resumeSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Recording initial turn before persistence");

        await session.run("Remember the word ALPHA and confirm with ACK.");
        const handle = session.describePersistence();
        expect(handle).not.toBeNull();
        expect(handle?.sessionId).toBeTruthy();

        await session.close();
        session = null;

        log("Resuming session from persistence handle");
        resumed = await client.resumeSession(handle!);
        const replayedHistory: AgentStreamEvent[] = [];
        for await (const event of resumed.streamHistory()) {
          replayedHistory.push(event);
        }
        log(
          `Replayed ${replayedHistory.length} history events: ${JSON.stringify(
            replayedHistory.map((e) => ({ type: e.type, timelineType: e.type === "timeline" ? e.item.type : undefined })),
            null,
            2
          )}`
        );
        expect(
          replayedHistory.some(
            (event) =>
              event.type === "timeline" && event.provider === "codex" && event.item.type === "assistant_message"
          )
        ).toBe(true);

        const response = await resumed.run("Respond with ACK-RESUMED and then stop.");
        expect(response.finalText.toLowerCase()).toContain("ack-resumed");

        const resumedHandle = resumed.describePersistence();
        expect(resumedHandle?.sessionId).toBe(handle?.sessionId);
      } finally {
        await session?.close();
        await resumed?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "interrupts a long-running shell command before it completes",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd, modeId: "full-access" };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      let runStartedAt: number | null = null;
      let durationMs = 0;
      let sawSleepCommand = false;
      let interruptIssued = false;

      try {
        session = await client.createSession(config);
        log("Launching sleep command interrupt test");

        const prompt = [
          "Run the exact shell command `sleep 60` using your shell tool.",
          "Do not run any additional commands or send a response until that command finishes.",
        ].join(" ");

        runStartedAt = Date.now();
        const stream = session.stream(prompt);

        for await (const event of stream) {
          if (event.type === "permission_requested" && session) {
            await session.respondToPermission(event.request.id, { behavior: "allow" });
          }

          if (
            event.type === "timeline" &&
            event.provider === "codex" &&
            event.item.type === "tool_call" &&
            event.item.server === "command" &&
            isSleepCommandToolCall(event.item)
          ) {
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
          throw new Error("Codex run never started");
        }
        durationMs = Date.now() - runStartedAt;
      } finally {
        if (durationMs === 0 && runStartedAt !== null) {
          durationMs = Date.now() - runStartedAt;
        }
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }

      expect(sawSleepCommand).toBe(true);
      expect(interruptIssued).toBe(true);
      expect(durationMs).toBeGreaterThan(0);
      expect(durationMs).toBeLessThan(60_000);
    },
    90_000
  );

  // Codex CLI currently doesn't emit approval request events even when approvalPolicy is set to on-request,
  // so we keep this test skipped until upstream support lands.
  test.skip(
    "emits permission requests and resolves them when approvals are handled (awaiting Codex support)",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = {
        provider: "codex",
        cwd,
        modeId: "full-access",
        extra: { codex: { approvalPolicy: "on-request" } },
      };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      try {
        session = await client.createSession(config);
        log("Processing Codex permission request stream");

        let captured: AgentPermissionRequest | null = null;
        const streamed = session.stream(
          "Request approval to run the command `pwd`, then run it after approval and stop."
        );
        for await (const event of streamed) {
          if (event.type === "permission_requested" && !captured) {
            captured = event.request;
            expect(session.getPendingPermissions()).toHaveLength(1);
            await session.respondToPermission(captured.id, { behavior: "allow" });
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(captured).not.toBeNull();
        expect(session.getPendingPermissions()).toHaveLength(0);

        const replay: AgentStreamEvent[] = [];
        for await (const event of session.streamHistory()) {
          replay.push(event);
        }

        expect(
          replay.some(
            (event) =>
              event.type === "permission_resolved" &&
              event.requestId === captured!.id &&
              event.resolution.behavior === "allow"
          )
        ).toBe(true);
        expect(
          replay.some(
            (event) =>
              event.type === "timeline" &&
              event.provider === "codex" &&
              event.item.type === "tool_call" &&
              event.item.server === "permission" &&
              event.item.status === "granted"
          )
        ).toBe(true);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "hydrates user messages from persisted history",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const client = new CodexAgentClient();
      const config: AgentSessionConfig = { provider: "codex", cwd };
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      let resumed: Awaited<ReturnType<typeof client.resumeSession>> | null = null;

      const promptMarker = `CODEX_USER_${Date.now().toString(36)}`;
      const prompt = `Reply only with ${promptMarker} and stop.`;
      const liveTimelineUpdates: StreamHydrationUpdate[] = [
        buildUserMessageUpdate("codex", prompt, "msg-codex-hydrated-user"),
      ];

      try {
        session = await client.createSession(config);
        const events = session.stream(prompt);
        for await (const event of events) {
          recordTimelineUpdate(liveTimelineUpdates, event);
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        const handle = session.describePersistence();
        expect(handle).toBeTruthy();

        await session.close();
        session = null;

        resumed = await client.resumeSession(handle!);
        const hydrationUpdates: StreamHydrationUpdate[] = [];
        for await (const event of resumed.streamHistory()) {
          recordTimelineUpdate(hydrationUpdates, event);
        }

        const liveState = hydrateStreamState(liveTimelineUpdates);
        const hydratedState = hydrateStreamState(hydrationUpdates);

        expect(stateIncludesUserMessage(liveState, promptMarker)).toBe(true);
        expect(stateIncludesUserMessage(hydratedState, promptMarker)).toBe(true);
        expect(stateIncludesSyntheticMessage(hydratedState)).toBe(false);

        const persisted = await client.listPersistedAgents({ limit: 200 });
        const persistedEntry = persisted.find((entry) => entry.sessionId === handle!.sessionId);
        expect(persistedEntry).toBeTruthy();
        const normalizedTitle = (persistedEntry?.title ?? "").toLowerCase();
        expect(normalizedTitle.startsWith("# agents.md instructions for")).toBe(false);
        expect(normalizedTitle.startsWith("<environment_context>")).toBe(false);
      } finally {
        await session?.close();
        await resumed?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );
});

describe("isSyntheticRolloutUserMessage", () => {
  test("flags AGENTS instruction payloads", () => {
    const text = `# AGENTS.md instructions for /Users/test

<INSTRUCTIONS>
Stay safe.
</INSTRUCTIONS>`;
    expect(isSyntheticRolloutUserMessage(text)).toBe(true);
  });

  test("flags environment context payloads", () => {
    const text = `<environment_context>
  <cwd>/Users/test/project</cwd>
  <approval_policy>never</approval_policy>
</environment_context>`;
    expect(isSyntheticRolloutUserMessage(text)).toBe(true);
  });

  test("allows real user prompts", () => {
    expect(isSyntheticRolloutUserMessage("investigate flaky tests")).toBe(false);
  });
});

type StreamHydrationUpdate = {
  event: Extract<AgentStreamEvent, { type: "timeline" }>;
  timestamp: Date;
};

function recordTimelineUpdate(target: StreamHydrationUpdate[], event: AgentStreamEvent) {
  if (event.type !== "timeline") {
    return;
  }
  target.push({
    event: event as StreamHydrationUpdate["event"],
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

function stateIncludesSyntheticMessage(state: StreamItem[]): boolean {
  return state.some((item) => {
    if (item.kind !== "user_message") {
      return false;
    }
    const normalized = item.text.trim().toLowerCase();
    return (
      normalized.startsWith("# agents.md instructions for") ||
      normalized.startsWith("<environment_context>")
    );
  });
}

async function prependSyntheticRolloutEntries(filePath: string, entries: Array<Record<string, unknown>>): Promise<void> {
  const existing = await fs.readFile(filePath, "utf8");
  const synthetic = entries.map((entry) => JSON.stringify(entry)).join("\n");
  const nextContent = synthetic.length ? `${synthetic}\n${existing}` : existing;
  await fs.writeFile(
    filePath,
    nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`,
    "utf8"
  );
}

async function resolveRolloutPathFromHandle(handle: AgentPersistenceHandle): Promise<string | null> {
  const pathFromMetadata = typeof handle.metadata?.codexRolloutPath === "string" ? handle.metadata.codexRolloutPath : null;
  if (pathFromMetadata && (await fileExists(pathFromMetadata))) {
    return pathFromMetadata;
  }

  const sessionDir = typeof handle.metadata?.codexSessionDir === "string" ? handle.metadata.codexSessionDir : null;
  const sessionId = handle.sessionId ?? (typeof handle.nativeHandle === "string" ? handle.nativeHandle : null);
  if (!sessionDir || !sessionId) {
    return null;
  }
  return findRolloutInDir(sessionDir, sessionId, 5);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findRolloutInDir(root: string, sessionId: string, maxDepth: number): Promise<string | null> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (
          entry.name.startsWith("rollout-") &&
          entry.name.includes(sessionId) &&
          (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))
        ) {
          return entryPath;
        }
      } else if (entry.isDirectory() && depth < maxDepth) {
        stack.push({ dir: entryPath, depth: depth + 1 });
      }
    }
  }
  return null;
}

function buildSyntheticInstructionEntry(sessionId: string): Record<string, unknown> {
  const text = [
    `# AGENTS.md instructions for ${sessionId}`,
    "",
    "<INSTRUCTIONS>",
    "Always obey the operator.",
    "</INSTRUCTIONS>",
  ].join("\n");
  return buildSyntheticResponseItem(text);
}

function buildSyntheticEnvironmentEntry(): Record<string, unknown> {
  const text = [
    "<environment_context>",
    "  <cwd>/tmp/workspace</cwd>",
    "  <approval_policy>never</approval_policy>",
    "  <sandbox_mode>danger-full-access</sandbox_mode>",
    "</environment_context>",
  ].join("\n");
  return buildSyntheticResponseItem(text);
}

function buildSyntheticResponseItem(text: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text,
        },
      ],
    },
  };
}
