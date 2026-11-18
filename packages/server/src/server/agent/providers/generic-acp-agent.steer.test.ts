import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { startAgentRun, type PromptDispatchResult } from "../agent-prompt.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

type SteerAnswer = "not_offered" | "accepted" | "refused" | "error";

interface SteerSend {
  dispatch: PromptDispatchResult["disposition"];
  methods: string[];
  steerRequests: unknown[];
  turnEvents: string[];
  userMessages: Array<{ text: string; turnId: string | undefined }>;
  assistantText: string;
}

describe("GenericACPAgentClient steering a running turn", () => {
  test("steers an agent that offers paseo/steer, and the turn stays one run", async () => {
    const send = await sendIntoRunningTurn("accepted");

    expect(send.dispatch).toBe("steered");
    expect(send.methods).toEqual(["initialize", "session/new", "session/prompt", "_paseo/steer"]);
    expect(send.steerRequests).toEqual([
      {
        sessionId: "session-1",
        messageId: "second-client",
        prompt: [{ type: "text", text: "second" }],
      },
    ]);
    expect(send.turnEvents).toEqual(["turn_started", "turn_completed"]);
    const [first, second] = send.userMessages;
    expect(send.userMessages.map((message) => message.text)).toEqual(["first", "second"]);
    expect(second?.turnId).toBe(first?.turnId);
    expect(send.assistantText).toBe("working on first. took second.");
  });

  test("replaces the run of an agent that does not offer paseo/steer", async () => {
    const send = await sendIntoRunningTurn("not_offered");

    expect(send.dispatch).toBe("turn_started");
    expect(send.methods).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "session/cancel",
      "session/prompt",
    ]);
    expect(send.steerRequests).toEqual([]);
    expect(send.turnEvents).toEqual([
      "turn_started",
      "turn_canceled",
      "turn_started",
      "turn_completed",
    ]);
    expect(send.userMessages.map((message) => message.text)).toEqual(["first", "second"]);
  });

  test.each(["refused", "error"] as const)(
    "replaces the run when the agent answers the steer request with %s",
    async (answer) => {
      const send = await sendIntoRunningTurn(answer);

      expect(send.dispatch).toBe("turn_started");
      expect(send.methods).toEqual([
        "initialize",
        "session/new",
        "session/prompt",
        "_paseo/steer",
        "session/cancel",
        "session/prompt",
      ]);
      expect(send.turnEvents).toEqual([
        "turn_started",
        "turn_canceled",
        "turn_started",
        "turn_completed",
      ]);
      expect(send.userMessages.map((message) => message.text)).toEqual(["first", "second"]);
    },
  );
});

// Starts a turn the fake agent holds open, then sends a second message into it the way the app
// does (replaceRunning with activeTurnBehavior "steer"), and reports what reached the agent.
async function sendIntoRunningTurn(answer: SteerAnswer): Promise<SteerSend> {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-acp-steer-"));
  const scriptPath = path.join(dir, "fake-acp-agent.cjs");
  const logPath = path.join(dir, "requests.jsonl");
  await writeFile(scriptPath, fakeACPAgentScript, "utf8");
  await writeFile(logPath, "", "utf8");

  const logger = createTestLogger();
  const client = new GenericACPAgentClient({
    logger,
    command: [process.execPath, scriptPath, answer, logPath],
    waitForInitialCommands: false,
  });
  const manager = new AgentManager({ clients: { acp: client }, logger });
  const agent = await manager.createAgent({ provider: "acp", cwd: dir }, undefined, {
    workspaceId: undefined,
  });
  const turnEvents: string[] = [];
  manager.subscribe(
    (event) => {
      if (event.type !== "agent_stream") return;
      if (
        event.event.type === "turn_started" ||
        event.event.type === "turn_completed" ||
        event.event.type === "turn_canceled" ||
        event.event.type === "turn_failed"
      ) {
        turnEvents.push(event.event.type);
      }
    },
    { agentId: agent.id, replayState: false },
  );
  const sendOptions = (clientMessageId: string) => ({
    replaceRunning: true,
    activeTurnBehavior: "steer" as const,
    runOptions: { clientMessageId },
  });

  try {
    await startAgentRun(manager, agent.id, "first", logger, sendOptions("first-client"));
    await expect
      .poll(async () => (await readRequests(logPath)).map((request) => request.method))
      .toContain("session/prompt");

    const dispatch = await startAgentRun(
      manager,
      agent.id,
      "second",
      logger,
      sendOptions("second-client"),
    );
    await expect.poll(() => turnEvents.at(-1)).toBe("turn_completed");
    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("idle");

    const requests = await readRequests(logPath);
    const rows = manager.fetchTimeline(agent.id, { limit: 0 }).rows;
    return {
      dispatch: dispatch.disposition,
      methods: requests.map((request) => request.method),
      steerRequests: requests
        .filter((request) => request.method === "_paseo/steer")
        .map((request) => request.params),
      turnEvents,
      userMessages: rows.flatMap((row) =>
        row.item.type === "user_message" ? [{ text: row.item.text, turnId: row.turnId }] : [],
      ),
      assistantText: rows
        .flatMap((row) => (row.item.type === "assistant_message" ? [row.item.text] : []))
        .join(""),
    };
  } finally {
    await manager.closeAgent(agent.id);
    await manager.flush();
    await rm(dir, { recursive: true, force: true });
  }
}

// The requests of the agent process that ran the turns. The client also starts a short-lived
// process of the same agent to probe it, which logs to the same file.
async function readRequests(logPath: string): Promise<Array<{ method: string; params: unknown }>> {
  const text = await readFile(logPath, "utf8");
  const requests = text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { pid: number; method: string; params: unknown });
  const sessionPid = requests.find((request) => request.method === "session/prompt")?.pid;
  return requests
    .filter((request) => request.pid === sessionPid && request.method !== "session/close")
    .map(({ method, params }) => ({ method, params }));
}

// An ACP agent whose first prompt runs until a steer or a cancel ends it. With "accepted" it
// offers paseo/steer, takes a steered message into that prompt and then ends it; "refused" and
// "error" offer it but turn the steer down. Every request and notification it gets is logged.
const fakeACPAgentScript = `
const fs = require("node:fs");
const readline = require("node:readline");

const [answer, logPath] = process.argv.slice(2);
const rl = readline.createInterface({ input: process.stdin });
let promptCount = 0;
let openPrompt = null;

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function say(sessionId, text) {
  write({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
}

function textOf(prompt) {
  return prompt.map((block) => block.text ?? "").join("");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) return;
  fs.appendFileSync(
    logPath,
    JSON.stringify({ pid: process.pid, method: message.method, params: message.params }) + "\\n",
  );
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize": {
      const agentCapabilities = answer === "not_offered" ? {} : { _meta: { "paseo/steer": true } };
      write({ id: message.id, result: { protocolVersion: 1, agentCapabilities } });
      return;
    }
    case "session/new":
      write({ id: message.id, result: { sessionId: "session-1" } });
      return;
    case "session/prompt":
      promptCount += 1;
      if (promptCount === 1) {
        openPrompt = { id: message.id, sessionId: params.sessionId };
        say(params.sessionId, "working on " + textOf(params.prompt) + ".");
        return;
      }
      say(params.sessionId, "answer to " + textOf(params.prompt) + ".");
      write({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    case "session/cancel":
      if (openPrompt) {
        write({ id: openPrompt.id, result: { stopReason: "cancelled" } });
        openPrompt = null;
      }
      return;
    case "_paseo/steer":
      if (answer === "error") {
        write({ id: message.id, error: { code: -32603, message: "steer failed" } });
        return;
      }
      if (answer !== "accepted" || !openPrompt) {
        write({ id: message.id, result: { accepted: false } });
        return;
      }
      write({ id: message.id, result: { accepted: true } });
      setTimeout(() => {
        say(openPrompt.sessionId, " took " + textOf(params.prompt) + ".");
        write({ id: openPrompt.id, result: { stopReason: "end_turn" } });
        openPrompt = null;
      }, 20);
      return;
    default:
      if (message.id !== undefined) write({ id: message.id, result: {} });
  }
});
`;
