import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { SessionOutboundMessage } from "../messages.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const FIRST_PROMPT = "START_BLOCKING_ACP_TOOL";
const STEER_PROMPT = "REDIRECT_BLOCKING_ACP_TOOL";
const FIRST_MESSAGE_ID = "blocking-acp-first";
const STEER_MESSAGE_ID = "blocking-acp-steer";

const blockingAcpProcess = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const tracePath = process.argv[2];
const responseOrder = process.argv[3];
const requestPermission = process.argv[4] === "permission";
const stopPreemption = process.argv[5] === "stop";
let firstPrompt = null;
let steerPrompt = null;
function trace(event) { fs.appendFileSync(tracePath, JSON.stringify(event) + "\n"); }
function send(id, result) { trace({ direction: "out", id, result }); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function notify(update) { trace({ direction: "out", method: "session/update", update }); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "blocking-session", update } }) + "\n"); }
function request(id, method, params) { trace({ direction: "out", id, method, params }); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); trace({ direction: "in", id: message.id, method: message.method, params: message.params, result: message.result });
  if (!message.method) return;
  if (message.method === "initialize") return send(message.id, { protocolVersion: message.params.protocolVersion, agentCapabilities: {} });
  if (message.method === "session/new") return send(message.id, { sessionId: "blocking-session", modes: { availableModes: [], currentModeId: null }, models: { availableModels: [], currentModelId: null }, configOptions: [] });
  if (message.method === "session/prompt") {
    if (!firstPrompt) {
      firstPrompt = message;
      notify({ sessionUpdate: "tool_call", toolCallId: "blocking-tool", title: "sleep 30", kind: "execute", status: "in_progress", rawInput: { command: "printf 'START\\n'; sleep 30; printf 'END\\n'" } });
      if (requestPermission) request(9001, "session/request_permission", { sessionId: "blocking-session", toolCall: { toolCallId: "blocking-tool", title: "sleep 30", kind: "execute", status: "pending" }, options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }] });
      return;
    }
    if (!steerPrompt) {
      steerPrompt = message;
      if (stopPreemption) return;
      if (responseOrder === "original-first") {
        send(firstPrompt.id, { stopReason: "end_turn" });
        return setImmediate(() => {
          notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BLOCKING_ACP_LATE_UPDATE" } });
          notify({ sessionUpdate: "tool_call_update", toolCallId: "blocking-tool", status: "completed", rawOutput: { output: "START\\nEND" } });
          notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BLOCKING_ACP_REDIRECT_ACK" } });
          send(message.id, { stopReason: "end_turn" });
        });
      }
      notify({ sessionUpdate: "tool_call_update", toolCallId: "blocking-tool", status: "completed", rawOutput: { output: "START\\nEND" } });
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BLOCKING_ACP_REDIRECT_ACK" } });
      send(message.id, { stopReason: "end_turn" });
      return setImmediate(() => send(firstPrompt.id, { stopReason: "end_turn" }));
    }
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BLOCKING_ACP_NEXT_ACK" } });
    return send(message.id, { stopReason: "end_turn" });
  }
  if (message.method === "session/cancel" && stopPreemption) {
    if (message.id !== undefined) send(message.id, {});
    send(firstPrompt.id, { stopReason: "cancelled" });
    return setImmediate(() => {
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BLOCKING_ACP_LATE_AFTER_STOP" } });
      send(steerPrompt.id, { stopReason: "end_turn" });
    });
  }
  send(message.id, {});
});
`;

function events(
  messages: SessionOutboundMessage[],
  agentId: string,
  type: "turn_started" | "turn_canceled" | "turn_completed",
): SessionOutboundMessage[] {
  return messages.filter(
    (message) =>
      message.type === "agent_stream" &&
      message.payload.agentId === agentId &&
      message.payload.event.type === type,
  );
}

interface ConcurrentPromptContract {
  originalResponseFirst: boolean;
  requestPermission: boolean;
}

interface WireEntry {
  direction: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: { outcome?: { outcome?: string; optionId?: string } };
}

function parseWireEntry(line: string): WireEntry {
  return JSON.parse(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWire(
  tracePath: string,
  predicate: (entry: WireEntry) => boolean,
  timeoutMs = 5_000,
): Promise<WireEntry[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const source = await readFile(tracePath, "utf8").catch(() => "");
    const entries = source.trim() ? source.trim().split("\n").map(parseWireEntry) : [];
    if (entries.some(predicate)) return entries;
    await sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ACP wire event`);
}

async function within<T>(label: string, timeoutMs: number, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForLateStopUpdate(client: DaemonClient, agentId: string): Promise<void> {
  await within(
    "late ACP stop update",
    4_000,
    (async () => {
      while (true) {
        const observed = await client.fetchAgentTimeline(agentId, { limit: 30 });
        const sawLateStopUpdate = observed.entries.some(isLateStopAssistantMessage);
        if (sawLateStopUpdate) return;
        await sleep(25);
      }
    })(),
  );
}

function isLateStopAssistantMessage(entry: { item: { type: string; text?: string } }): boolean {
  return (
    entry.item.type === "assistant_message" && entry.item.text?.includes("LATE_AFTER_STOP") === true
  );
}

describe("daemon E2E - configured ACP concurrent-prompt steering", () => {
  let testDir: string | null = null;
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;
  let unsubscribe: (() => void) | null = null;

  afterEach(async () => {
    unsubscribe?.();
    await client?.close();
    await daemon?.close();
    if (testDir) await rm(testDir, { recursive: true, force: true });
    testDir = null;
    daemon = null;
    client = null;
    unsubscribe = null;
  });

  async function runContract({
    originalResponseFirst,
    requestPermission,
  }: ConcurrentPromptContract): Promise<void> {
    testDir = await mkdtemp(path.join(tmpdir(), "paseo-blocking-acp-"));
    const tracePath = path.join(testDir, "acp-wire.jsonl");
    const processPath = path.join(testDir, "blocking-acp.cjs");
    await writeFile(processPath, blockingAcpProcess);
    daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      providerOverrides: {
        "blocking-acp": {
          extends: "acp",
          label: "Blocking ACP contract process",
          command: [
            process.execPath,
            processPath,
            tracePath,
            originalResponseFirst ? "original-first" : "steer-first",
            ...(requestPermission ? ["permission"] : []),
          ],
          params: { activeTurnSteering: "concurrent_prompt" },
        },
      },
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "blocking-acp" } });
    const collector = createMessageCollector(client);
    unsubscribe = collector.unsubscribe;
    const agent = await client.createAgent({
      provider: "blocking-acp",
      cwd: testDir,
      title: "blocking-acp-steer-contract",
    });

    await client.sendAgentMessage(agent.id, FIRST_PROMPT, { messageId: FIRST_MESSAGE_ID });
    await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "running", 15_000);
    await client.sendAgentMessage(agent.id, STEER_PROMPT, {
      messageId: STEER_MESSAGE_ID,
      activeTurnBehavior: "steer",
    });
    expect((await client.waitForFinish(agent.id, 15_000)).status).toBe("idle");

    const wire = (await readFile(tracePath, "utf8")).trim().split("\n").map(parseWireEntry);
    const prompts = wire.filter(
      (entry) => entry.direction === "in" && entry.method === "session/prompt",
    );
    expect(wire.filter((entry) => entry.method === "session/cancel")).toHaveLength(0);
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[0]?.params)).toContain(FIRST_PROMPT);
    expect(JSON.stringify(prompts[1]?.params)).toContain(STEER_PROMPT);
    const starts = events(collector.messages, agent.id, "turn_started");
    expect(starts).toHaveLength(1);
    expect(events(collector.messages, agent.id, "turn_canceled")).toHaveLength(0);
    expect(events(collector.messages, agent.id, "turn_completed")).toHaveLength(1);
    const timeline = await client.fetchAgentTimeline(agent.id, { limit: 20 });
    const users = timeline.entries.filter((entry) => entry.item.type === "user_message");
    expect(users).toHaveLength(2);
    expect(users.map((entry) => entry.turnId)).toEqual([
      starts[0]?.payload.event.turnId,
      starts[0]?.payload.event.turnId,
    ]);
    expect(
      timeline.entries.some(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.includes("REDIRECT_ACK"),
      ),
    ).toBe(true);
    if (requestPermission) {
      expect(
        wire.some(
          (entry) =>
            entry.direction === "in" &&
            entry.id === 9001 &&
            entry.result?.outcome?.outcome === "selected" &&
            entry.result.outcome.optionId === "deny",
        ),
      ).toBe(true);
    }
    if (originalResponseFirst) {
      const lateUpdate = timeline.entries.find(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.includes("LATE_UPDATE"),
      );
      expect(lateUpdate?.turnId).toBe(starts[0]?.payload.event.turnId);
      const completedTool = timeline.entries.find(
        (entry) => entry.item.type === "tool_call" && entry.item.status === "completed",
      );
      expect(completedTool?.turnId).toBe(starts[0]?.payload.event.turnId);
    }
    await client.sendAgentMessage(agent.id, "BLOCKING_ACP_NEXT", {
      messageId: "blocking-acp-next",
    });
    expect((await client.waitForFinish(agent.id, 15_000)).status).toBe("idle");
    const afterNextPrompt = await client.fetchAgentTimeline(agent.id, { limit: 30 });
    expect(
      afterNextPrompt.entries.some(
        (entry) => entry.item.type === "assistant_message" && entry.item.text.includes("NEXT_ACK"),
      ),
    ).toBe(true);
  }

  test("keeps the original foreground turn while the steer response arrives first", async () => {
    await runContract({ originalResponseFirst: false, requestPermission: false });
  }, 60_000);

  test("keeps late ACP updates on the original turn when the original response arrives first", async () => {
    await runContract({ originalResponseFirst: true, requestPermission: true });
  }, 60_000);

  test("Stop preempts an unresolved concurrent steer and prevents its late response from resuming", async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "paseo-blocking-acp-stop-"));
    const tracePath = path.join(testDir, "acp-wire.jsonl");
    const processPath = path.join(testDir, "blocking-acp.cjs");
    await writeFile(processPath, blockingAcpProcess);
    daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      providerOverrides: {
        "blocking-acp": {
          extends: "acp",
          label: "Blocking ACP Stop contract process",
          command: [process.execPath, processPath, tracePath, "steer-first", "", "stop"],
          params: { activeTurnSteering: "concurrent_prompt" },
        },
      },
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "blocking-acp-stop" } });
    const collector = createMessageCollector(client);
    unsubscribe = collector.unsubscribe;
    const agent = await client.createAgent({
      provider: "blocking-acp",
      cwd: testDir,
      title: "blocking-acp-stop-contract",
    });
    await client.sendAgentMessage(agent.id, FIRST_PROMPT, { messageId: FIRST_MESSAGE_ID });
    await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "running", 15_000);
    const steer = client.sendAgentMessage(agent.id, STEER_PROMPT, {
      messageId: STEER_MESSAGE_ID,
      activeTurnBehavior: "steer",
    });
    void steer.catch(() => undefined);
    await waitForWire(
      tracePath,
      (entry) =>
        entry.direction === "in" &&
        entry.method === "session/prompt" &&
        JSON.stringify(entry.params).includes(STEER_PROMPT),
    );
    await within("Stop delivers ACP session/cancel", 4_000, client.cancelAgent(agent.id));
    const stoppedWire = await waitForWire(
      tracePath,
      (entry) => entry.direction === "in" && entry.method === "session/cancel",
      4_000,
    );
    expect(stoppedWire.filter((entry) => entry.method === "session/cancel")).toHaveLength(1);
    await Promise.allSettled([steer]);
    expect((await client.waitForFinish(agent.id, 10_000)).status).toBe("idle");
    await waitForLateStopUpdate(client, agent.id);
    expect(events(collector.messages, agent.id, "turn_started")).toHaveLength(1);
    expect(events(collector.messages, agent.id, "turn_canceled")).toHaveLength(1);
    expect(events(collector.messages, agent.id, "turn_completed")).toHaveLength(0);
    const timeline = await client.fetchAgentTimeline(agent.id, { limit: 30 });
    expect(
      timeline.entries.some(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.includes("LATE_AFTER_STOP"),
      ),
    ).toBe(true);
    const steeredUserRow = timeline.entries.find(
      (entry) => entry.item.type === "user_message" && entry.item.text === STEER_PROMPT,
    );
    expect(steeredUserRow?.turnId).toBe(
      events(collector.messages, agent.id, "turn_started")[0]?.payload.event.turnId,
    );
  }, 60_000);
});
