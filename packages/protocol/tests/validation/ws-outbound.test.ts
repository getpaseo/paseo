import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WSOutboundMessageSchema as GeneratedWSOutboundMessageSchema } from "../../src/generated/validation/ws-outbound.aot.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "../../src/messages.js";
import { normalizeWSOutboundMessage } from "../../src/validation/model-normalization.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesZodKnownOutput(oracleOutput: unknown, generatedOutput: unknown): boolean {
  if (Object.is(oracleOutput, generatedOutput)) {
    return true;
  }

  if (
    typeof oracleOutput !== "object" ||
    oracleOutput === null ||
    typeof generatedOutput !== "object" ||
    generatedOutput === null ||
    Array.isArray(oracleOutput) !== Array.isArray(generatedOutput)
  ) {
    return false;
  }

  if (Array.isArray(oracleOutput) && Array.isArray(generatedOutput)) {
    if (oracleOutput.length !== generatedOutput.length) {
      return false;
    }
    return oracleOutput.every((value, index) =>
      matchesZodKnownOutput(value, generatedOutput[index]),
    );
  }

  if (!isRecord(oracleOutput) || !isRecord(generatedOutput)) {
    return false;
  }

  return Object.keys(oracleOutput).every(
    (key) =>
      Object.hasOwn(generatedOutput, key) &&
      matchesZodKnownOutput(oracleOutput[key], generatedOutput[key]),
  );
}

function expectGeneratedValidatorAgreesWithZod(input: unknown): void {
  const generated = parseGenerated(input);
  const zod = parseZod(input);

  expect(generated.success).toBe(zod.success);
  if (!generated.success || !zod.success) {
    return;
  }

  expect(
    matchesZodKnownOutput(
      normalizeWSOutboundMessage(zod.data),
      normalizeWSOutboundMessage(generated.data as typeof zod.data),
    ),
  ).toBe(true);
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

function timelineToolCallMessage(
  status: "running" | "completed" | "failed" | "canceled",
): WSOutboundMessage {
  const streamMessage = toolCallMessage(status);
  const streamPayload = streamMessage.message.payload;

  if (streamPayload.event.type !== "timeline") {
    throw new Error("expected timeline event");
  }

  return {
    type: "session",
    message: {
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: `timeline-${status}`,
        agentId: "agent-tool-call",
        agent: null,
        direction: "tail",
        projection: "canonical",
        epoch: "epoch-tool-call",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
        startCursor: null,
        endCursor: null,
        hasOlder: false,
        hasNewer: false,
        entries: [
          {
            provider: "opencode",
            item: streamPayload.event.item,
            timestamp: "2026-07-04T00:00:00.000Z",
            seqStart: 1,
            seqEnd: 1,
            sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
            collapsed: [],
          },
        ],
        error: null,
      },
    },
  };
}

function legacyWorkspaceDescriptor() {
  return {
    id: "workspace-legacy",
    projectId: "project-legacy",
    projectDisplayName: "Legacy Project",
    projectRootPath: "/tmp/legacy-project",
    projectKind: "git",
    workspaceKind: "directory",
    name: "legacy-project",
    status: "active",
    activityAt: "2026-07-04T00:00:00.000Z",
    gitRuntime: null,
    githubRuntime: null,
  };
}

function legacyFetchWorkspacesMessage(): unknown {
  return {
    type: "session",
    message: {
      type: "fetch_workspaces_response",
      payload: {
        requestId: "workspaces-legacy",
        subscriptionId: null,
        entries: [legacyWorkspaceDescriptor()],
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
        },
      },
    },
  };
}

function legacyWorkspaceUpdateMessage(): unknown {
  return {
    type: "session",
    message: {
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: legacyWorkspaceDescriptor(),
      },
    },
  };
}

function legacyDirectorySuggestionsMessage(): unknown {
  return {
    type: "session",
    message: {
      type: "directory_suggestions_response",
      payload: {
        directories: ["/tmp/legacy-project"],
        error: null,
        requestId: "directories-legacy",
      },
    },
  };
}

function legacyCheckoutPrStatusMessage(): unknown {
  return {
    type: "session",
    message: {
      type: "checkout_pr_status_response",
      payload: {
        cwd: "/tmp/legacy-project",
        githubFeaturesEnabled: true,
        error: null,
        requestId: "checkout-pr-legacy",
        status: {
          number: 123,
          url: "https://github.com/getpaseo/paseo/pull/123",
          title: "Legacy PR",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "legacy",
          isMerged: false,
          github: {
            mergeStateStatus: "CLEAN",
          },
        },
      },
    },
  };
}

describe("WS outbound zod-aot validation", () => {
  it("matches Zod on captured inbound fixtures modulo passthrough keys", () => {
    expectGeneratedValidatorAgreesWithZod(readJsonFixture("providers-snapshot.json"));
    expectGeneratedValidatorAgreesWithZod(readJsonFixture("fetch-agent-timeline-response.json"));
    for (const message of readJsonlFixture("agent-stream-burst.jsonl")) {
      expectGeneratedValidatorAgreesWithZod(message);
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
    expectGeneratedValidatorAgreesWithZod(toolCallMessage("running"));
    expectGeneratedValidatorAgreesWithZod(toolCallMessage("completed"));
    expectGeneratedValidatorAgreesWithZod(toolCallMessage("failed"));
    expectGeneratedValidatorAgreesWithZod(toolCallMessage("canceled"));
  });

  it("matches Zod for every historical timeline tool_call status", () => {
    expectGeneratedValidatorAgreesWithZod(timelineToolCallMessage("running"));
    expectGeneratedValidatorAgreesWithZod(timelineToolCallMessage("completed"));
    expectGeneratedValidatorAgreesWithZod(timelineToolCallMessage("failed"));
    expectGeneratedValidatorAgreesWithZod(timelineToolCallMessage("canceled"));
  });

  it("reports output divergence when generated comparison omits a Zod default", () => {
    const input = readJsonFixture("providers-snapshot.json");
    const zod = parseZod(input);
    expect(zod.success).toBe(true);
    if (!zod.success) {
      return;
    }

    const brokenGenerated = cloneJson(zod.data) as WSOutboundMessage;
    if (brokenGenerated.type !== "session") {
      throw new Error("expected session fixture");
    }
    if (brokenGenerated.message.type !== "get_providers_snapshot_response") {
      throw new Error("expected providers snapshot fixture");
    }
    delete (brokenGenerated.message.payload.entries[0] as { enabled?: boolean }).enabled;

    expect(matchesZodKnownOutput(zod.data, brokenGenerated)).toBe(false);
  });

  it("matches Zod defaults for legacy compatibility fields", () => {
    const providersSnapshot = cloneJson(readJsonFixture("providers-snapshot.json"));
    if (
      typeof providersSnapshot === "object" &&
      providersSnapshot !== null &&
      "message" in providersSnapshot &&
      typeof providersSnapshot.message === "object" &&
      providersSnapshot.message !== null &&
      "payload" in providersSnapshot.message &&
      typeof providersSnapshot.message.payload === "object" &&
      providersSnapshot.message.payload !== null &&
      "entries" in providersSnapshot.message.payload &&
      Array.isArray(providersSnapshot.message.payload.entries)
    ) {
      delete (providersSnapshot.message.payload.entries[0] as { enabled?: boolean }).enabled;
    }

    expectGeneratedValidatorAgreesWithZod(providersSnapshot);
    expectGeneratedValidatorAgreesWithZod(legacyFetchWorkspacesMessage());
    expectGeneratedValidatorAgreesWithZod(legacyWorkspaceUpdateMessage());
    expectGeneratedValidatorAgreesWithZod(legacyDirectorySuggestionsMessage());
    expectGeneratedValidatorAgreesWithZod(legacyCheckoutPrStatusMessage());
  });
});
