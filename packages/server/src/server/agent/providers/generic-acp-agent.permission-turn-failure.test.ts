import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient permission requests when a turn ends early", () => {
  test.each([
    { ending: "fail", terminalEvent: "turn_failed" },
    { ending: "cancel", terminalEvent: "turn_canceled" },
    { ending: "end_turn", terminalEvent: "turn_completed" },
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
          const requested = permissionRequests(events)[0]!;
          expect(resolvedEvents(events)).toEqual([
            {
              type: "permission_resolved",
              provider: "acp",
              requestId: requested.request.id,
              resolution: { behavior: "deny", message: "Permission request canceled" },
              turnId: requested.turnId,
            },
          ]);

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

  test.each(["completed", "failed"] as const)(
    "cancels only the matching permission when its tool becomes %s",
    async (status) => {
      await withFakeACPAgent(status, async (command, cwd) => {
        const client = new GenericACPAgentClient({ logger: createTestLogger(), command });
        const session = await client.createSession({ provider: "acp", cwd });
        try {
          const events = collectEvents(session);
          await session.startTurn("turn one");
          await waitForToolUpdate(events);
          expect(pendingToolIds(session)).toEqual(["tool-2"]);
          expect(resolvedEvents(events)).toEqual([
            expect.objectContaining({ requestId: permissionRequests(events)[0]!.request.id }),
          ]);
        } finally {
          await session.close();
        }
      });
    },
  );

  test("keeps a permission raised outside a turn answerable after another turn completes", async () => {
    await withFakeACPAgent("outside_turn", async (command, cwd) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });
      const session = await client.createSession({ provider: "acp", cwd });
      try {
        const outside = session.getPendingPermissions();
        expect(pendingToolIds(session)).toEqual(["tool-outside"]);
        const events = collectEvents(session);
        await session.startTurn("turn one");
        await waitForEvent(events, "turn_completed");
        expect(session.getPendingPermissions()).toEqual(outside);
        await session.respondToPermission(outside[0]!.id, { behavior: "allow" });
        expect(session.getPendingPermissions()).toEqual([]);
      } finally {
        await session.close();
      }
    });
  });

  test.each(["fail", "cancel"] as const)(
    "settles an outside-turn permission that the manager clears when a turn ends with %s",
    async (ending) => {
      await withFakeACPAgent(`outside_${ending}`, async (command, cwd) => {
        const logger = createTestLogger();
        const client = new GenericACPAgentClient({
          logger,
          command,
          waitForInitialCommands: false,
        });
        const manager = new AgentManager({ clients: { acp: client }, logger });
        const agent = await manager.createAgent({ provider: "acp", cwd }, undefined, {
          workspaceId: undefined,
        });
        try {
          await waitForManagedPermission(manager, agent.id);
          if (ending === "fail") {
            await expect(manager.runAgent(agent.id, "turn one")).rejects.toThrow(
              "turn failed with a permission open",
            );
          } else {
            await expect(manager.runAgent(agent.id, "turn one")).resolves.toMatchObject({
              canceled: true,
            });
          }
          expect(manager.getPendingPermissions(agent.id)).toEqual([]);
          const result = await manager.runAgent(agent.id, "turn two");
          expect(result.finalText).toBe(
            'perm-outside answered: {"outcome":{"outcome":"cancelled"}}',
          );
        } finally {
          await manager.closeAgent(agent.id);
          await manager.flush();
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

async function waitForManagedPermission(manager: AgentManager, agentId: string): Promise<void> {
  await expect.poll(() => manager.getPendingPermissions(agentId).length).toBe(1);
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

function permissionRequests(events: AgentStreamEvent[]) {
  return events.filter((event) => event.type === "permission_requested");
}

function resolvedEvents(events: AgentStreamEvent[]) {
  return events.filter((event) => event.type === "permission_resolved");
}

function pendingToolIds(session: AgentSession) {
  return session.getPendingPermissions().map((request) => request.metadata?.toolCallId);
}

async function waitForToolUpdate(events: AgentStreamEvent[]): Promise<void> {
  await expect.poll(() => assistantText(events)).toBe("tool terminal");
}

async function withFakeACPAgent(
  ending:
    | "fail"
    | "cancel"
    | "end_turn"
    | "completed"
    | "failed"
    | "outside_turn"
    | "outside_fail"
    | "outside_cancel",
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

// Turn one ends while its permission request is still open.
// Later turns report whether that request was ever answered.
const fakeACPAgentScript = `
const readline = require("node:readline");

const ending = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
let promptCount = 0;
let permissionAnswer = null;
let outsidePermissionAnswer = null;

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function ask(sessionId, requestId, toolCallId) {
  const toolCall = { toolCallId, title: "echo hello", kind: "execute", status: "pending" };
  write({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", ...toolCall } } });
  write({
    id: requestId,
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
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    if (message.id === "perm-1") permissionAnswer = message.result ?? { error: message.error };
    if (message.id === "perm-outside") outsidePermissionAnswer = message.result ?? { error: message.error };
    return;
  }
  if (message.method === "initialize") {
    write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    if (ending.startsWith("outside_")) ask("session-1", "perm-outside", "tool-outside");
    write({ id: message.id, result: { sessionId: "session-1" } });
    return;
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    promptCount += 1;
    if (promptCount === 1) {
      ask(sessionId, "perm-1", "tool-1");
      if (ending === "completed" || ending === "failed") {
        ask(sessionId, "perm-2", "tool-2");
        write({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: ending } } });
        write({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tool terminal" } } } });
        return;
      }
      setTimeout(() => {
        if (ending === "cancel" || ending === "outside_cancel") {
          write({ id: message.id, result: { stopReason: "cancelled" } });
        } else if (ending === "end_turn" || ending === "outside_turn") {
          write({ id: message.id, result: { stopReason: "end_turn" } });
        } else {
          write({ id: message.id, error: { code: -32603, message: "turn failed with a permission open" } });
        }
      }, 50);
      return;
    }
    const answer = ending.startsWith("outside_") ? outsidePermissionAnswer : permissionAnswer;
    const requestId = ending.startsWith("outside_") ? "perm-outside" : "perm-1";
    const state = answer === null ? "unanswered" : "answered: " + JSON.stringify(answer);
    write({
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: requestId + " " + state } },
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
