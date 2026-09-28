import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { createPiExtensionHost } from "../index.js";
import { readSubagentFixture, verifySubagentFixture } from "../subagent-fixture-test.js";
import { streamPiHistory } from "../../history-mapper.js";
import { parseToolResult } from "../../tool-call-mapper.js";

const CHILD_FILE = "/tmp/paseo-gotgenes-child.jsonl";

/** Spawns a background child the way the plugin's result text and details do. */
function spawnBackground(host: ReturnType<typeof createPiExtensionHost>, file?: string): void {
  host.mapToolCall({
    callId: "spawn-1",
    toolName: "subagent",
    args: { subagent_type: "general-purpose", prompt: "Inspect" },
    status: "completed",
    result: parseToolResult({
      content: [
        {
          type: "text",
          text: `Agent started in background.\nAgent ID: abc\n${file ? `\nOutput file: ${file}\n` : ""}\nYou will be notified when this agent completes.`,
        },
      ],
      details: { agentId: "abc", status: "background" },
    }),
  });
}

function collectRunningChildResult(
  host: ReturnType<typeof createPiExtensionHost>,
  transcriptPath = CHILD_FILE,
) {
  return host.mapToolCall({
    callId: "follow-1",
    toolName: "get_subagent_result",
    args: { agent_id: "abc" },
    status: "completed",
    result: parseToolResult({
      content: [{ type: "text", text: "Agent: abc | Status: running" }],
      details: { agentId: "abc", status: "running", transcriptPath },
    }),
  });
}

describe("@gotgenes/pi-subagents adapter", () => {
  test("maps captured foreground lifecycle live and on replay", async () => {
    const events = await verifySubagentFixture(
      readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url)),
    );
    expect(
      events
        .filter((event) => event.event.type === "upsert")
        .map((event) => (event.event.type === "upsert" ? event.event.status : null)),
    ).toEqual(["running", "completed"]);
  });
  test("correlates a background notification and result collection", async () => {
    const source = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url));
    const file = (
      source.messages.find((message) => message.role === "custom") as {
        details: { outputFile: string };
      }
    ).details.outputFile;
    const fixture = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url), {
      from: file,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    const events = await verifySubagentFixture(fixture);
    const upserts = events
      .filter((event) => event.event.type === "upsert")
      .map((event) => (event.event.type === "upsert" ? event.event : null));
    expect(upserts.map((event) => event?.status)).toEqual([
      "running",
      "running",
      "completed",
      "completed",
    ]);
    expect(new Set(upserts.map((event) => event?.id)).size).toBe(1);
    expect(events.filter((event) => event.event.type === "timeline").length).toBeGreaterThan(0);
  });
  test("keeps claimed notification text visible in history", async () => {
    const fixture = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url));
    const text = fixture.messages.find((message) => message.role === "custom")?.content;
    const events = [];
    for await (const event of streamPiHistory("pi", fixture.messages)) events.push(event);
    expect(events).toContainEqual({
      type: "timeline",
      provider: "pi",
      item: { type: "assistant_message", text },
    });
    expect(events.some((event) => event.type === "provider_subagent")).toBe(true);
  });
  test("shares the subagent tool name with Nico without claiming Nico's args", () => {
    const host = createPiExtensionHost();
    const nico = host.mapToolCall({
      callId: "nico",
      toolName: "subagent",
      args: { agent: "scout", task: "Inspect" },
      status: "running",
      result: null,
    });
    const gotgenes = host.mapToolCall({
      callId: "gotgenes",
      toolName: "subagent",
      args: { subagent_type: "general-purpose", prompt: "Inspect" },
      status: "running",
      result: null,
    });
    expect(nico?.detail).toEqual(
      expect.objectContaining({ type: "sub_agent", subAgentType: "scout" }),
    );
    expect(gotgenes?.detail).toEqual(
      expect.objectContaining({ type: "sub_agent", subAgentType: "general-purpose" }),
    );
    expect(
      host.mapToolCall({
        callId: "foreign",
        toolName: "subagent",
        args: { description: "Inspect" },
        status: "running",
        result: null,
      }),
    ).toBeUndefined();
  });

  test("hands a running background child's transcript over from the spawn text", () => {
    const host = createPiExtensionHost();
    const output = host.mapToolCall({
      callId: "spawn-1",
      toolName: "subagent",
      args: { subagent_type: "general-purpose", prompt: "Inspect" },
      status: "completed",
      result: parseToolResult({
        content: [
          {
            type: "text",
            text: `Agent started in background.\nAgent ID: abc\n\nOutput file: ${CHILD_FILE}\n`,
          },
        ],
        details: { agentId: "abc", status: "background" },
      }),
    });
    expect(output?.childSessions).toEqual([{ id: "spawn-1", file: CHILD_FILE }]);
  });

  test("hands a running child's transcript over from get_subagent_result", () => {
    const host = createPiExtensionHost();
    spawnBackground(host);
    const output = collectRunningChildResult(host);
    expect(output?.subagents).toEqual([
      expect.objectContaining({ id: "spawn-1", status: "running" }),
    ]);
    expect(output?.childSessions).toEqual([{ id: "spawn-1", file: CHILD_FILE }]);
  });

  test("hands the same transcript over once", () => {
    const host = createPiExtensionHost();
    spawnBackground(host);
    collectRunningChildResult(host, CHILD_FILE);
    expect(collectRunningChildResult(host)?.childSessions).toEqual([]);
  });

  test("reports mid-run progress as a notification item", () => {
    const host = createPiExtensionHost();
    spawnBackground(host);
    const output = host.mapCustomMessage({
      role: "custom",
      customType: "subagent-update",
      content: "<subagent-update>Reading the workspace</subagent-update>",
      details: { id: "abc", description: "Inspect", message: "Reading the workspace" },
    });
    expect(output?.timeline).toEqual([
      { type: "notification", level: "info", message: "Reading the workspace" },
    ]);
    expect(output?.events).toContainEqual({
      type: "timeline",
      provider: "pi",
      item: { type: "notification", level: "info", message: "Reading the workspace" },
    });
  });
});
