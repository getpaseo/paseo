import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { createPiExtensionHost } from "../index.js";
import { readSubagentFixture, verifySubagentFixture } from "../subagent-fixture-test.js";
import { parseToolResult } from "../../tool-call-mapper.js";

describe("@tintinweb/pi-subagents adapter", () => {
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
  test("uses a structured notification to complete a background child", async () => {
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
    expect(
      events
        .filter((event) => event.event.type === "upsert")
        .map((event) => (event.event.type === "upsert" ? event.event.status : null)),
    ).toEqual(["running", "running", "completed"]);
    expect(events.filter((event) => event.event.type === "timeline").length).toBeGreaterThan(0);
  });
  test("declines foreign Agent results", () => {
    expect(
      createPiExtensionHost().mapToolCall({
        callId: "foreign",
        toolName: "Agent",
        args: { prompt: "foo" },
        status: "completed",
        result: { details: { agentId: "other", status: "completed" } },
      }),
    ).toBeUndefined();
  });

  test("hands a running background child's transcript over from the spawn text", () => {
    const file = "/tmp/pi-subagents-50/tasks/98cdb309-045e-45d.output";
    const output = createPiExtensionHost().mapToolCall({
      callId: "spawn-1",
      toolName: "Agent",
      args: { subagent_type: "general-purpose", prompt: "Inspect" },
      status: "completed",
      result: parseToolResult({
        content: [
          {
            type: "text",
            text: `Agent started in background.\nAgent ID: 98cdb309\nType: Agent\nDescription: list files\nOutput file: ${file}\n\nYou will be notified when this agent completes.`,
          },
        ],
        details: { agentId: "98cdb309", status: "background" },
      }),
    });
    expect(output?.subagents).toEqual([
      expect.objectContaining({ id: "spawn-1", status: "running" }),
    ]);
    expect(output?.childSessions).toEqual([{ id: "spawn-1", file }]);
  });
});
