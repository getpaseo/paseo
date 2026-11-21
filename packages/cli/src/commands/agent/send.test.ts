import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { runSendCommand, type AgentSendOptions } from "./send.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// A daemon whose agent has answered before: its timeline starts with an old, valid reply.
let timeline: Array<{ seqStart: number; item: { type: string; text: string } }> = [];
// What each coming turn writes; null is a turn that ends without any text.
let turns: Array<string | null> = [];
const append = (type: string, text: string) =>
  timeline.push({ seqStart: timeline.length + 1, item: { type, text } });

const sendAgentMessage = vi.fn(async (..._args: unknown[]) => append("user_message", "sent"));
const waitForFinish = vi.fn(async (..._args: unknown[]) => {
  const text = turns.shift();
  if (typeof text === "string") append("assistant_message", text);
  const last = timeline.findLast((entry) => entry.item.type === "assistant_message");
  return { status: "idle", final: { id: "agent-1" }, lastMessage: last?.item.text ?? null };
});

vi.mock("../../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/client.js")>()),
  connectToDaemon: vi.fn(async () => ({
    fetchAgent: async (id: string) =>
      id.startsWith("agent") ? { agent: { id: "agent-1" } } : null,
    sendAgentMessage,
    waitForFinish,
    fetchAgentTimeline: async () => ({
      epoch: "e1",
      window: { maxSeq: timeline.length },
      entries: timeline,
    }),
    close: async () => undefined,
  })),
}));

const schema = JSON.stringify({
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
});

// `target` is a prefix; the daemon knows the agent as agent-1.
function send(options: Omit<AgentSendOptions, "daemonTarget"> = {}, target = "agent") {
  return runSendCommand(target, "describe it", { ...options, daemonTarget }, {} as Command);
}

describe("send --output-schema", () => {
  const originalAgentId = process.env.PASEO_AGENT_ID;

  beforeEach(() => {
    delete process.env.PASEO_AGENT_ID;
    timeline = [];
    append("assistant_message", '{"summary":"old"}');
    turns = [];
    sendAgentMessage.mockClear();
    waitForFinish.mockClear();
    vi.mocked(connectToDaemon).mockClear();
  });

  afterEach(() => {
    if (originalAgentId === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = originalAgentId;
  });

  it("asks the existing agent with the schema in the message and returns the validated object", async () => {
    turns = ['{"summary":"ok"}'];

    const result = await send({ outputSchema: schema });

    expect(result.schema.serialize?.(result.data)).toEqual({ summary: "ok" });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    const [agentId, text] = sendAgentMessage.mock.calls[0] as [string, string];
    expect(agentId).toBe("agent-1");
    expect(text).toContain("describe it");
    expect(text).toContain('"summary"');
  });

  it("does not take an older reply for this turn's answer", async () => {
    turns = [null];

    const error = await send({ outputSchema: schema, maxRetries: "0" }).catch((err) => err);

    expect(error).toMatchObject({ code: "OUTPUT_SCHEMA_FAILED" });
    expect(error.details).toBeUndefined();
  });

  it("fails on the first mismatch with --max-retries 0 and hands back the evidence", async () => {
    turns = ['{"summary":1}'];

    await expect(send({ outputSchema: schema, maxRetries: "0" })).rejects.toMatchObject({
      code: "OUTPUT_SCHEMA_FAILED",
      details: {
        validationErrors: [expect.stringContaining("/summary")],
        lastResponse: '{"summary":1}',
      },
    });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("retries twice by default, each time to the same agent, and returns what a retry fixed", async () => {
    turns = ['{"summary":1}', '{"summary":2}', '{"summary":3}'];
    await expect(send({ outputSchema: schema })).rejects.toMatchObject({
      details: { lastResponse: '{"summary":3}' },
    });
    expect(sendAgentMessage.mock.calls.map((call) => call[0])).toEqual([
      "agent-1",
      "agent-1",
      "agent-1",
    ]);

    turns = ['{"summary":1}', '{"summary":"fixed"}'];
    const result = await send({ outputSchema: schema, maxRetries: "1" });
    expect(result.schema.serialize?.(result.data)).toEqual({ summary: "fixed" });
  });

  it("waits as long as --wait-timeout says, 10 minutes otherwise", async () => {
    turns = ['{"summary":"ok"}', '{"summary":"ok"}'];

    await send({ outputSchema: schema, waitTimeout: "90s" });
    expect(waitForFinish).toHaveBeenLastCalledWith("agent-1", 90_000);
    await send({ outputSchema: schema });
    expect(waitForFinish).toHaveBeenLastCalledWith("agent-1", 600_000);
  });

  it("sends nothing to an agent that does not exist", async () => {
    await expect(send({ outputSchema: schema }, "nobody")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["--output-schema with --no-wait", { outputSchema: schema, wait: false }],
    ["--max-retries without --output-schema", { maxRetries: "0" }],
    ["a schema that is not JSON", { outputSchema: "{not json" }],
  ])("rejects %s before connecting", async (_name, options) => {
    await expect(send(options)).rejects.toMatchObject({ code: expect.any(String) });
    expect(connectToDaemon).not.toHaveBeenCalled();
  });
});

describe("send without --output-schema", () => {
  it("sends the prompt as written and waits as before", async () => {
    sendAgentMessage.mockClear();
    waitForFinish.mockClear();
    turns = [];

    const result = await send({ waitTimeout: "5m" });

    expect(sendAgentMessage.mock.calls[0]?.[1]).toBe("describe it");
    expect(waitForFinish).toHaveBeenCalledWith("agent", 300_000);
    expect(result.data).toMatchObject({ agentId: "agent-1", status: "completed" });
    expect(result.schema.serialize).toBeUndefined();
  });
});
