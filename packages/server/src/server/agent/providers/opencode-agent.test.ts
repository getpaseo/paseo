import { describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { OpenCodeAgentClient } from "./opencode-agent.js";
import type {
  AgentSessionConfig,
  AgentStreamEvent,
  ToolCallTimelineItem,
  AssistantMessageTimelineItem,
  UserMessageTimelineItem,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-agent-test-"));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

const TEST_MODEL = "opencode/glm-4.7-free";

interface TurnResult {
  events: AgentStreamEvent[];
  assistantMessages: AssistantMessageTimelineItem[];
  toolCalls: ToolCallTimelineItem[];
  allTimelineItems: AgentTimelineItem[];
  turnCompleted: boolean;
  turnFailed: boolean;
  error?: string;
}

async function collectTurnEvents(
  iterator: AsyncGenerator<AgentStreamEvent>
): Promise<TurnResult> {
  const result: TurnResult = {
    events: [],
    assistantMessages: [],
    toolCalls: [],
    allTimelineItems: [],
    turnCompleted: false,
    turnFailed: false,
  };

  for await (const event of iterator) {
    result.events.push(event);

    if (event.type === "timeline") {
      result.allTimelineItems.push(event.item);
      if (event.item.type === "assistant_message") {
        result.assistantMessages.push(event.item);
      } else if (event.item.type === "tool_call") {
        result.toolCalls.push(event.item);
      }
    }

    if (event.type === "turn_completed") {
      result.turnCompleted = true;
      break;
    }
    if (event.type === "turn_failed") {
      result.turnFailed = true;
      result.error = event.error;
      break;
    }
  }

  return result;
}

// Skip integration tests in CI - requires real OpenCode server
const shouldSkip = process.env.CI === "true";

describe.skipIf(shouldSkip)("OpenCodeAgentClient", () => {
  const buildConfig = (cwd: string): AgentSessionConfig => ({
    provider: "opencode",
    cwd,
    model: TEST_MODEL,
  });

  test(
    "creates a session with valid id and provider",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient();
      const session = await client.createSession(buildConfig(cwd));

      // HARD ASSERT: Session has required fields
      expect(typeof session.id).toBe("string");
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.provider).toBe("opencode");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    60_000
  );

  test(
    "single turn completes with streaming deltas",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient();
      const session = await client.createSession(buildConfig(cwd));

      const iterator = session.stream("Say hello");
      const turn = await collectTurnEvents(iterator);

      // HARD ASSERT: Turn completed successfully
      expect(turn.turnCompleted).toBe(true);
      expect(turn.turnFailed).toBe(false);

      // HARD ASSERT: Got at least one assistant message
      expect(turn.assistantMessages.length).toBeGreaterThan(0);

      // HARD ASSERT: Each delta is non-empty
      for (const msg of turn.assistantMessages) {
        expect(msg.text.length).toBeGreaterThan(0);
      }

      // HARD ASSERT: Concatenated deltas form non-empty response
      const fullResponse = turn.assistantMessages.map((m) => m.text).join("");
      expect(fullResponse.length).toBeGreaterThan(0);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "user prompt text never appears in assistant_message",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient();
      const session = await client.createSession(buildConfig(cwd));

      const userMarker = "UNIQUE_USER_MARKER_XYZ789";
      const iterator = session.stream(`Reply with ACK only. ${userMarker}`);
      const turn = await collectTurnEvents(iterator);

      // HARD ASSERT: Turn completed
      expect(turn.turnCompleted).toBe(true);

      // HARD ASSERT: Got assistant response
      expect(turn.assistantMessages.length).toBeGreaterThan(0);

      // HARD ASSERT: User marker never appears in ANY assistant message
      for (const msg of turn.assistantMessages) {
        expect(msg.text).not.toContain(userMarker);
      }

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "multi-turn preserves context",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient();
      const session = await client.createSession(buildConfig(cwd));

      const secretCode = "ZEBRA_42";

      // Turn 1: Establish a fact
      const turn1 = await collectTurnEvents(
        session.stream(`Remember this code: ${secretCode}. Just say OK.`)
      );

      // HARD ASSERT: Turn 1 completed
      expect(turn1.turnCompleted).toBe(true);
      expect(turn1.assistantMessages.length).toBeGreaterThan(0);

      // Turn 2: Recall the fact
      const turn2 = await collectTurnEvents(
        session.stream("What was the code I told you? Reply with just the code.")
      );

      // HARD ASSERT: Turn 2 completed
      expect(turn2.turnCompleted).toBe(true);
      expect(turn2.assistantMessages.length).toBeGreaterThan(0);

      // HARD ASSERT: Response contains the secret code (context preserved)
      const fullResponse = turn2.assistantMessages.map((m) => m.text).join("");
      expect(fullResponse).toContain(secretCode);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    180_000
  );

  test(
    "emits tool_call events for file operations",
    async () => {
      const cwd = tmpCwd();
      const testFile = path.join(cwd, "test-file.txt");
      writeFileSync(testFile, "original content\n");

      const client = new OpenCodeAgentClient();
      const session = await client.createSession(buildConfig(cwd));

      const iterator = session.stream(`Read the file at ${testFile}`);
      const turn = await collectTurnEvents(iterator);

      // HARD ASSERT: Turn completed
      expect(turn.turnCompleted).toBe(true);

      // HARD ASSERT: Got at least one tool call
      expect(turn.toolCalls.length).toBeGreaterThan(0);

      // HARD ASSERT: Tool call has required fields
      const firstTool = turn.toolCalls[0];
      expect(typeof firstTool.name).toBe("string");
      expect(firstTool.name.length).toBeGreaterThan(0);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "can be interrupted during streaming",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient();
      const session = await client.createSession(buildConfig(cwd));

      const events: AgentStreamEvent[] = [];
      const iterator = session.stream(
        "Write a very long essay about computing history with at least 10 paragraphs."
      );

      // Collect a few events then interrupt
      for await (const event of iterator) {
        events.push(event);
        if (events.length >= 5) {
          await session.interrupt();
          break;
        }
      }

      // HARD ASSERT: Received events before interruption
      expect(events.length).toBeGreaterThanOrEqual(5);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    60_000
  );

  test(
    "run() returns accumulated response text",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient();
      const session = await client.createSession(buildConfig(cwd));

      const marker = "OPENCODE_ACK_TOKEN";
      const result = await session.run(`Reply with exactly: ${marker}`);

      // HARD ASSERT: Result has finalText
      expect(typeof result.finalText).toBe("string");

      // HARD ASSERT: Response contains the marker
      expect(result.finalText).toContain(marker);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "handles permission requests",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient();
      const session = await client.createSession(buildConfig(cwd));

      const events: AgentStreamEvent[] = [];
      const iterator = session.stream("Run the command 'echo hello' in a shell.");

      for await (const event of iterator) {
        events.push(event);

        if (event.type === "permission_requested") {
          // HARD ASSERT: Permission request has required fields
          expect(typeof event.request.id).toBe("string");
          expect(event.request.id.length).toBeGreaterThan(0);

          // Approve it
          await session.respondToPermission(event.request.id, {
            behavior: "allow",
          });
        }

        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }

      // HARD ASSERT: Turn completed (either with or without permission)
      const hasCompletion = events.some(
        (e) => e.type === "turn_completed" || e.type === "turn_failed"
      );
      expect(hasCompletion).toBe(true);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "listModels returns models with required fields",
    async () => {
      const client = new OpenCodeAgentClient();
      const models = await client.listModels();

      // HARD ASSERT: Returns an array
      expect(Array.isArray(models)).toBe(true);

      // HARD ASSERT: At least one model is returned (OpenCode has connected providers)
      expect(models.length).toBeGreaterThan(0);

      // HARD ASSERT: Each model has required fields with correct types
      for (const model of models) {
        expect(model.provider).toBe("opencode");
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(typeof model.label).toBe("string");
        expect(model.label.length).toBeGreaterThan(0);

        // HARD ASSERT: Model ID contains provider prefix (format: providerId/modelId)
        expect(model.id).toContain("/");
      }
    },
    60_000
  );

  test(
    "streamHistory returns exact conversation history after multi-turn session",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient();
      const session = await client.createSession(buildConfig(cwd));

      // Turn 1: Ask agent to remember a secret
      const secretCode = "HISTORY_TEST_42";
      const turn1 = await collectTurnEvents(
        session.stream(`Remember this code: ${secretCode}. Reply with just "OK".`)
      );

      // HARD ASSERT: Turn 1 completed
      expect(turn1.turnCompleted).toBe(true);
      expect(turn1.assistantMessages.length).toBeGreaterThan(0);

      // Turn 2: Ask agent to read a file (triggers tool use)
      const testFile = path.join(cwd, "history-test.txt");
      writeFileSync(testFile, "history test content\n");
      const turn2 = await collectTurnEvents(
        session.stream(`Read the file at ${testFile} and tell me what it contains.`)
      );

      // HARD ASSERT: Turn 2 completed with tool call
      expect(turn2.turnCompleted).toBe(true);
      expect(turn2.toolCalls.length).toBeGreaterThan(0);
      expect(turn2.assistantMessages.length).toBeGreaterThan(0);

      // Now load history from the session
      const historyEvents: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) {
        historyEvents.push(event);
      }

      // HARD ASSERT: History contains events
      expect(historyEvents.length).toBeGreaterThan(0);

      // Extract timeline items from history
      const historyTimeline = historyEvents
        .filter((e): e is Extract<AgentStreamEvent, { type: "timeline" }> => e.type === "timeline")
        .map((e) => e.item);

      // HARD ASSERT: History has user messages
      const userMessages = historyTimeline.filter(
        (item): item is UserMessageTimelineItem => item.type === "user_message"
      );
      expect(userMessages.length).toBe(2);

      // HARD ASSERT: First user message contains our secret code prompt
      expect(userMessages[0].text).toContain(secretCode);

      // HARD ASSERT: Second user message contains the file read request
      expect(userMessages[1].text).toContain("history-test.txt");

      // HARD ASSERT: History has assistant messages
      const assistantMessages = historyTimeline.filter(
        (item): item is AssistantMessageTimelineItem => item.type === "assistant_message"
      );
      expect(assistantMessages.length).toBeGreaterThan(0);

      // HARD ASSERT: History has tool calls from turn 2
      const toolCalls = historyTimeline.filter(
        (item): item is ToolCallTimelineItem => item.type === "tool_call"
      );
      expect(toolCalls.length).toBeGreaterThan(0);

      // HARD ASSERT: Tool call has correct structure
      const firstToolCall = toolCalls[0];
      expect(typeof firstToolCall.name).toBe("string");
      expect(firstToolCall.name.length).toBeGreaterThan(0);
      expect(typeof firstToolCall.callId).toBe("string");
      expect(firstToolCall.callId!.length).toBeGreaterThan(0);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    180_000
  );
});
