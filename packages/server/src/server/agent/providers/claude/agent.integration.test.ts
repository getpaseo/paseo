import { describe, expect, test, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentSession,
  AgentStreamEvent,
  ToolCallTimelineItem,
} from "../../agent-sdk-types.js";
import { isProviderAvailable } from "../../../daemon-e2e/agent-configs.js";
import { findExecutable } from "../../../../utils/executable.js";
import { withTimeout } from "../../../../utils/promise-timeout.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeQuery } from "./query.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";

const logger = pino({ level: "silent" });
const client = new ClaudeAgentClient({ logger });

function tmpCwd(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createEmptyPrompt(): AsyncGenerator<SDKUserMessage, void, undefined> {
  return (async function* empty() {})();
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function isTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

async function nextStreamEvent(
  stream: AsyncGenerator<AgentStreamEvent>,
  timeoutMs: number,
  label: string,
): Promise<IteratorResult<AgentStreamEvent>> {
  return await withTimeout(stream.next(), timeoutMs, `Timed out waiting for ${label}`);
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>,
  options?: {
    timeoutMs?: number;
    onEvent?: (event: AgentStreamEvent) => Promise<void> | void;
  },
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  while (true) {
    const next = await nextStreamEvent(stream, options?.timeoutMs ?? 45_000, "stream event");
    if (next.done || !next.value) {
      return events;
    }
    const event = next.value;
    events.push(event);
    await options?.onEvent?.(event);
    if (isTerminalEvent(event)) {
      return events;
    }
  }
}

async function collectUntil(
  stream: AsyncGenerator<AgentStreamEvent>,
  predicate: (event: AgentStreamEvent) => boolean,
  timeoutMs = 45_000,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  while (true) {
    const next = await nextStreamEvent(stream, timeoutMs, "matching stream event");
    if (next.done || !next.value) {
      throw new Error("Stream ended before the expected event arrived");
    }
    const event = next.value;
    events.push(event);
    if (predicate(event) || isTerminalEvent(event)) {
      return events;
    }
  }
}

function collectSubscribedUntil(
  session: AgentSession,
  predicate: (event: AgentStreamEvent) => boolean,
  timeoutMs = 45_000,
): Promise<AgentStreamEvent[]> {
  return new Promise((resolve, reject) => {
    const events: AgentStreamEvent[] = [];
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for subscribed event`));
    }, timeoutMs);

    const unsubscribe = session.subscribe((event) => {
      events.push(event);
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(events);
    });
  });
}

function getAssistantText(events: AgentStreamEvent[]): string {
  return events
    .flatMap((event) => {
      if (event.type !== "timeline" || event.item.type !== "assistant_message") {
        return [];
      }
      return [event.item.text];
    })
    .join("\n");
}

function getToolCalls(events: AgentStreamEvent[]): ToolCallTimelineItem[] {
  return events.flatMap((event) => {
    if (event.type !== "timeline" || event.item.type !== "tool_call") {
      return [];
    }
    return [event.item];
  });
}

function getLatestCompletedBashCall(events: AgentStreamEvent[]): ToolCallTimelineItem | undefined {
  return [...getToolCalls(events)]
    .toReversed()
    .find((item) => item.status === "completed" && item.name.toLowerCase() === "bash");
}

function getInternalQuery(session: AgentSession): unknown {
  return (session as AgentSession & { query?: unknown }).query ?? null;
}

async function createSession(params?: {
  cwdPrefix?: string;
  modeId?: string;
  title?: string;
}): Promise<{ cwd: string; session: AgentSession }> {
  const cwd = tmpCwd(params?.cwdPrefix ?? "claude-agent-integration-");
  const session = await client.createSession({
    provider: "claude",
    cwd,
    title: params?.title ?? "ClaudeAgentSession integration",
    modeId: params?.modeId ?? "acceptEdits",
    model: "haiku",
  });
  return { cwd, session };
}

async function cleanupSession(handle: { cwd: string; session: AgentSession }): Promise<void> {
  await handle.session.close().catch(() => undefined);
  try {
    rmSync(handle.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
      throw error;
    }
  }
}

describe("ClaudeAgentSession integration", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("streams a basic response turn end-to-end", async () => {
    const handle = await createSession({
      cwdPrefix: "claude-agent-basic-response-",
    });

    try {
      const events = await collectUntilTerminal(
        streamSession(handle.session, "Respond with exactly: HELLO_WORLD"),
      );

      expect(events[0]).toMatchObject({
        type: "turn_started",
        provider: "claude",
      });
      expect(
        events.some(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "assistant_message" &&
            compactText(event.item.text).includes("hello_world"),
        ),
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: "turn_completed",
        provider: "claude",
      });
    } finally {
      await cleanupSession(handle);
    }
  }, 60_000);

  test("keeps bypassPermissions available after a thinking-option restart", async () => {
    const handle = await createSession({
      cwdPrefix: "claude-agent-bypass-restart-",
      modeId: "bypassPermissions",
    });

    try {
      await handle.session.setMode("acceptEdits");
      await handle.session.setThinkingOption("high");
      await expect(handle.session.setMode("bypassPermissions")).resolves.toBeUndefined();
    } finally {
      await cleanupSession(handle);
    }
  }, 60_000);

  test("supportedModels returns the current abstract Claude SDK model shape", async () => {
    const claudeBinary = await findExecutable("claude");
    if (!claudeBinary) throw new Error("claude binary required for this integration test");
    const query = claudeQuery({
      prompt: createEmptyPrompt(),
      options: {
        cwd: process.cwd(),
        permissionMode: "plan",
        includePartialMessages: false,
        settingSources: ["user", "project"],
        pathToClaudeCodeExecutable: claudeBinary,
      },
    });

    try {
      const models = await query.supportedModels();

      expect(models.length).toBeGreaterThanOrEqual(3);
      expect(models).toContainEqual(
        expect.objectContaining({
          value: "default",
          displayName: "Default (recommended)",
          supportedEffortLevels: ["low", "medium", "high", "max"],
        }),
      );
      expect(models).toContainEqual(
        expect.objectContaining({
          value: "haiku",
          displayName: "Haiku",
          description: expect.stringContaining("Haiku 4.5"),
        }),
      );
      expect(
        models.some(
          (model) =>
            model.description.includes("Opus 4.6") || model.description.includes("Sonnet 4.6"),
        ),
      ).toBe(true);
    } finally {
      await query.return?.();
    }
  }, 60_000);

  test("runs a real Bash tool call and completes it", async () => {
    const handle = await createSession({
      cwdPrefix: "claude-agent-basic-tool-",
    });

    try {
      const events = await collectUntilTerminal(
        streamSession(
          handle.session,
          [
            "Use the Bash tool.",
            "Run exactly: echo TOOL_TEST_OUTPUT",
            "After the command completes, reply with exactly: TOOL_DONE",
          ].join(" "),
        ),
      );

      const bashCalls = getToolCalls(events).filter((item) => item.name.toLowerCase() === "bash");
      const completedBashCall = getLatestCompletedBashCall(events);

      expect(bashCalls.length).toBeGreaterThan(0);
      expect(completedBashCall).toBeDefined();
      expect(completedBashCall?.detail.type).toBe("shell");
      expect(
        completedBashCall?.detail.type === "shell" &&
          completedBashCall.detail.output?.includes("TOOL_TEST_OUTPUT"),
      ).toBe(true);
      expect(compactText(getAssistantText(events))).toContain("tool_done");
      expect(events.at(-1)).toMatchObject({
        type: "turn_completed",
        provider: "claude",
      });
    } finally {
      await cleanupSession(handle);
    }
  }, 60_000);

  test("interrupts a running Bash turn and continues on the same query", async () => {
    const handle = await createSession({
      cwdPrefix: "claude-agent-interrupt-continue-",
    });

    try {
      const firstStream = streamSession(
        handle.session,
        [
          "Use the Bash tool.",
          "Run exactly: sleep 10",
          "Do not use a background task.",
          "Do not do anything after starting the command.",
        ].join(" "),
      );

      const initialEvents = await collectUntil(
        firstStream,
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.name.toLowerCase() === "bash",
        45_000,
      );
      const firstQuery = getInternalQuery(handle.session);

      expect(firstQuery).toBeTruthy();

      await handle.session.interrupt();

      const canceledEvents = await collectUntilTerminal(firstStream, {
        timeoutMs: 20_000,
      });
      const allFirstTurnEvents = [...initialEvents, ...canceledEvents];

      expect(
        allFirstTurnEvents.some(
          (event) => event.type === "turn_canceled" && event.provider === "claude",
        ),
      ).toBe(true);

      const followUpEvents = await collectUntilTerminal(
        streamSession(handle.session, "Respond with exactly: AFTER_INTERRUPT_OK"),
      );
      const secondQuery = getInternalQuery(handle.session);

      expect(secondQuery).toBe(firstQuery);
      expect(compactText(getAssistantText(followUpEvents))).toContain("after_interrupt_ok");
      expect(followUpEvents.at(-1)).toMatchObject({
        type: "turn_completed",
        provider: "claude",
      });
    } finally {
      await cleanupSession(handle);
    }
  }, 60_000);

  test("creates an autonomous live turn when a background task completes", async () => {
    const handle = await createSession({
      cwdPrefix: "claude-agent-autonomous-",
    });
    const autonomousWakeToken = `AUTONOMOUS_WAKE_${Date.now().toString(36)}`;

    try {
      const foregroundEvents = await collectUntilTerminal(
        streamSession(
          handle.session,
          [
            "Use the Bash tool with run_in_background.",
            "Run exactly: sleep 3",
            "Do not wait for the task result.",
            "Reply immediately with exactly: SPAWNED",
            `When the background task completes later, reply with exactly: ${autonomousWakeToken}`,
          ].join(" "),
        ),
        { timeoutMs: 90_000 },
      );

      expect(compactText(getAssistantText(foregroundEvents))).toContain("spawned");

      const liveEvents = await collectSubscribedUntil(
        handle.session,
        (event) => isTerminalEvent(event),
        90_000,
      );

      expect(
        liveEvents.some((event) => event.type === "turn_started" && event.provider === "claude"),
      ).toBe(true);
      expect(liveEvents.at(-1)).toMatchObject({
        type: "turn_completed",
        provider: "claude",
      });
    } finally {
      await cleanupSession(handle);
    }
  }, 180_000);

  test("surfaces permission requests and resumes after approval", async () => {
    const handle = await createSession({
      cwdPrefix: "claude-agent-permission-",
      modeId: "default",
    });
    const permissionFile = path.join(handle.cwd, "permission.txt");

    try {
      const events = await collectUntilTerminal(
        streamSession(
          handle.session,
          [
            "Use the Bash tool to run exactly: printf 'PERM_TEST' > permission.txt",
            "If approval is required, wait for approval.",
            "After the command succeeds, reply with exactly: PERM_DONE",
          ].join(" "),
        ),
        {
          timeoutMs: 45_000,
          onEvent: async (event) => {
            if (event.type !== "permission_requested") {
              return;
            }
            await handle.session.respondToPermission(event.request.id, {
              behavior: "allow",
            });
          },
        },
      );

      const permissionRequest = events.find(
        (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
          event.type === "permission_requested",
      );
      const permissionResolved = events.find(
        (event): event is Extract<AgentStreamEvent, { type: "permission_resolved" }> =>
          event.type === "permission_resolved",
      );
      const completedBashCall = getLatestCompletedBashCall(events);

      expect(permissionRequest?.request.kind).toBe("tool");
      expect(permissionResolved).toMatchObject({
        type: "permission_resolved",
        provider: "claude",
        resolution: { behavior: "allow" },
      });
      expect(completedBashCall).toBeDefined();
      expect(readFileSync(permissionFile, "utf8")).toBe("PERM_TEST");
      expect(compactText(getAssistantText(events))).toContain("perm_done");
      expect(events.at(-1)).toMatchObject({
        type: "turn_completed",
        provider: "claude",
      });
    } finally {
      await cleanupSession(handle);
    }
  }, 60_000);
});
