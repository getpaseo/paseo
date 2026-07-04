import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WSOutboundMessageSchema as GeneratedWSOutboundMessageSchema } from "../generated/validation/ws-outbound.aot.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "../messages.js";
import { normalizeWSOutboundMessage } from "./model-normalization.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function readJsonFixture(fileName: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, fileName), "utf8"));
}

function readJsonlFixture(fileName: string): unknown[] {
  return readFileSync(resolve(fixturesDir, fileName), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function parseGenerated(
  input: unknown,
): ReturnType<typeof GeneratedWSOutboundMessageSchema.safeParse> {
  return GeneratedWSOutboundMessageSchema.safeParse(input);
}

function parseZod(input: unknown): ReturnType<typeof WSOutboundMessageSchema.safeParse> {
  return WSOutboundMessageSchema.safeParse(input);
}

function expectValidatorsAgree(input: unknown): void {
  const generated = parseGenerated(input);
  const zod = parseZod(input);

  expect(generated.success).toBe(zod.success);
  if (!generated.success || !zod.success) {
    return;
  }

  const zodKnownGenerated = parseZod(generated.data);
  expect(zodKnownGenerated.success).toBe(true);
  if (!zodKnownGenerated.success) {
    return;
  }

  expect(normalizeWSOutboundMessage(zodKnownGenerated.data)).toEqual(
    normalizeWSOutboundMessage(zod.data),
  );
}

function corruptProviderModelId(input: unknown): unknown {
  const corrupted = cloneJson(input);
  if (typeof corrupted !== "object" || corrupted === null || !("message" in corrupted)) {
    return corrupted;
  }

  const message = corrupted.message;
  if (typeof message !== "object" || message === null || !("payload" in message)) {
    return corrupted;
  }

  const payload = message.payload;
  if (typeof payload !== "object" || payload === null || !("entries" in payload)) {
    return corrupted;
  }

  const entries = payload.entries;
  if (!Array.isArray(entries)) {
    return corrupted;
  }

  const firstEntry = entries[0];
  if (typeof firstEntry !== "object" || firstEntry === null || !("models" in firstEntry)) {
    return corrupted;
  }

  const models = firstEntry.models;
  if (Array.isArray(models)) {
    const firstModel = models[0];
    if (typeof firstModel === "object" && firstModel !== null) {
      Object.assign(firstModel, { id: 123 });
    }
  }

  return corrupted;
}

function corruptTimelineEntries(input: unknown): unknown {
  const corrupted = cloneJson(input);
  if (
    typeof corrupted === "object" &&
    corrupted !== null &&
    "message" in corrupted &&
    typeof corrupted.message === "object" &&
    corrupted.message !== null &&
    "payload" in corrupted.message &&
    typeof corrupted.message.payload === "object" &&
    corrupted.message.payload !== null
  ) {
    Object.assign(corrupted.message.payload, { entries: "not-an-array" });
  }
  return corrupted;
}

function corruptAgentStreamSeq(input: unknown): unknown {
  const corrupted = cloneJson(input);
  if (
    typeof corrupted === "object" &&
    corrupted !== null &&
    "message" in corrupted &&
    typeof corrupted.message === "object" &&
    corrupted.message !== null &&
    "payload" in corrupted.message &&
    typeof corrupted.message.payload === "object" &&
    corrupted.message.payload !== null
  ) {
    Object.assign(corrupted.message.payload, { seq: "not-a-number" });
  }
  return corrupted;
}

function toolCallMessage(
  status: "running" | "completed" | "failed" | "canceled",
): WSOutboundMessage {
  return {
    type: "session",
    message: {
      type: "agent_stream",
      payload: {
        agentId: "agent-tool-call",
        event: {
          type: "timeline",
          provider: "opencode",
          item: {
            type: "tool_call",
            callId: `call-${status}`,
            name: "shell",
            detail: { type: "unknown", input: null, output: null },
            status,
            error: status === "failed" ? "boom" : null,
          },
        },
        timestamp: "2026-07-04T00:00:00.000Z",
        seq: 1,
        epoch: "epoch-tool-call",
      },
    },
  };
}

describe("WS outbound zod-aot validation", () => {
  it("matches Zod on captured inbound fixtures modulo passthrough keys", () => {
    expectValidatorsAgree(readJsonFixture("providers-snapshot.json"));
    expectValidatorsAgree(readJsonFixture("fetch-agent-timeline-response.json"));
    for (const message of readJsonlFixture("agent-stream-burst.jsonl")) {
      expectValidatorsAgree(message);
    }
  });

  it("rejects corrupted variants with both validators", () => {
    const providersSnapshot = readJsonFixture("providers-snapshot.json");
    const timeline = readJsonFixture("fetch-agent-timeline-response.json");
    const agentStream = readJsonlFixture("agent-stream-burst.jsonl")[0];

    for (const corrupted of [
      corruptProviderModelId(providersSnapshot),
      corruptTimelineEntries(timeline),
      corruptAgentStreamSeq(agentStream),
    ]) {
      expect(parseGenerated(corrupted).success).toBe(false);
      expect(parseZod(corrupted).success).toBe(false);
    }
  });

  it("matches Zod for every tool_call status", () => {
    expectValidatorsAgree(toolCallMessage("running"));
    expectValidatorsAgree(toolCallMessage("completed"));
    expectValidatorsAgree(toolCallMessage("failed"));
    expectValidatorsAgree(toolCallMessage("canceled"));
  });
});
