import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient permission requests when a turn ends early", () => {
  test.each([
    { ending: "fail", terminalEvent: "turn_failed" },
    { ending: "cancel", terminalEvent: "turn_canceled" },
  ] as const)(
    "answers a permission request left open by a $terminalEvent turn with cancelled",
    async ({ ending, terminalEvent }) => {
      await withFakeACPAgent(ending, async (command, cwd) => {
        const client = new GenericACPAgentClient({ logger: createTestLogger(), command });
        const session = await client.createSession({ provider: "acp", cwd });
        try {
          const events = collectEvents(session);

          await session.startTurn("turn one");
          await waitForEvent(events, terminalEvent);
          expect(hasEvent(events, "permission_requested")).toBe(true);
          expect(session.getPendingPermissions()).toEqual([]);

          const replyStart = events.length;
          await session.startTurn("turn two");
          await waitForEvent(events, "turn_completed", replyStart);

          expect(assistantText(events.slice(replyStart))).toBe(
            'perm-1 answered: {"outcome":{"outcome":"cancelled"}}',
          );
        } finally {
          await session.close();
        }
      });
    },
  );
});

function collectEvents(session: AgentSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

function hasEvent(
  events: AgentStreamEvent[],
  type: AgentStreamEvent["type"],
  fromIndex = 0,
): boolean {
  return events.slice(fromIndex).some((event) => event.type === type);
}

async function waitForEvent(
  events: AgentStreamEvent[],
  type: AgentStreamEvent["type"],
  fromIndex = 0,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!hasEvent(events, type, fromIndex)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${type}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assistantText(events: AgentStreamEvent[]): string {
  return events
    .flatMap((event) =>
      event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
    )
    .join("");
}

async function withFakeACPAgent(
  ending: "fail" | "cancel",
  run: (command: [string, ...string[]], cwd: string) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-acp-permission-turn-failure-"));
  try {
    const scriptPath = path.join(testDir, "fake-acp-agent.cjs");
    await writeFile(scriptPath, fakeACPAgentScript, "utf8");
    await run([process.execPath, scriptPath, ending], testDir);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

// Turn one asks for permission, then fails or is cancelled while the request is
// still open.
// Later turns report whether that request was ever answered.
const fakeACPAgentScript = `
const readline = require("node:readline");

const ending = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
let promptCount = 0;
let permissionAnswer = null;

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && message.id === "perm-1") {
    permissionAnswer = message.result ?? { error: message.error };
    return;
  }
  if (message.method === "initialize") {
    write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    write({ id: message.id, result: { sessionId: "session-1" } });
    return;
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    promptCount += 1;
    if (promptCount === 1) {
      const toolCall = { toolCallId: "tool-1", title: "echo hello", kind: "execute", status: "pending" };
      write({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", ...toolCall } } });
      write({
        id: "perm-1",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall,
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      setTimeout(() => {
        if (ending === "cancel") {
          write({ id: message.id, result: { stopReason: "cancelled" } });
        } else {
          write({ id: message.id, error: { code: -32603, message: "turn failed with a permission open" } });
        }
      }, 50);
      return;
    }
    const state = permissionAnswer === null ? "unanswered" : "answered: " + JSON.stringify(permissionAnswer);
    write({
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "perm-1 " + state } },
      },
    });
    write({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.id !== undefined) {
    write({ id: message.id, result: {} });
  }
});
`;
