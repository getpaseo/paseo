import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { createPiExtensionHost } from "../index.js";
import { readSubagentFixture, verifySubagentFixture } from "../subagent-fixture-test.js";
import type { PiAgentMessage } from "../../rpc-types.js";
import { streamPiHistory } from "../../history-mapper.js";

describe("@tintinweb/pi-subagents adapter", () => {
  test("exposes the background output file while the child is running", () => {
    const mapping = createPiExtensionHost().mapToolCall({
      callId: "call-1",
      toolName: "Agent",
      args: { subagent_type: "Explore", prompt: "Inspect" },
      status: "completed",
      result: {
        details: { agentId: "native-1", status: "background" },
        content: [
          { type: "text", text: "Agent started in background.\nOutput file: /tmp/child.output\n" },
        ],
      },
    });
    expect(mapping?.subagents).toEqual([
      expect.objectContaining({ id: "call-1", status: "running" }),
    ]);
    expect(mapping?.childSessions).toEqual([{ id: "call-1", file: "/tmp/child.output" }]);
  });
  test("marks a foreground child that wrapped up at its turn limit as completed", () => {
    const mapping = createPiExtensionHost().mapToolCall({
      callId: "call-1",
      toolName: "Agent",
      args: { subagent_type: "Explore", prompt: "Inspect" },
      status: "completed",
      result: {
        details: { agentId: "native-1", status: "steered" },
        content: [{ type: "text", text: "Wrapped up (turn limit)" }],
      },
    });
    expect(mapping?.subagents).toEqual([
      expect.objectContaining({ id: "call-1", status: "completed" }),
      {
        type: "timeline",
        id: "call-1",
        item: { type: "assistant_message", text: "Wrapped up (turn limit)" },
      },
    ]);
    expect(mapping?.detail).toEqual({
      type: "sub_agent",
      subAgentType: "Explore",
      description: "Inspect",
      log: "",
    });
  });
  test("maps captured foreground lifecycle live and on replay", async () => {
    const events = await verifySubagentFixture(
      readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url)),
    );
    expect(
      events
        .filter((event) => event.event.type === "upsert")
        .map((event) => (event.event.type === "upsert" ? event.event.status : null)),
    ).toEqual(["running", "completed"]);
    expect(
      events.flatMap((event) => (event.event.type === "timeline" ? [event.event] : [])),
    ).toEqual([
      {
        type: "timeline",
        id: "call_458926",
        item: {
          type: "assistant_message",
          text: "Agent completed in 6.6s (1 tool uses, 18.8k token).\n\nThe workspace directory `/tmp/paseo-pi-extension-phase3/workspace` is empty (no files or hidden dotfiles).",
        },
      },
    ]);
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
  test("completes every background child in a grouped notification", async () => {
    const events = await verifySubagentFixture(
      readSubagentFixture(new URL("./fixtures/background-group.json", import.meta.url)),
    );
    const finalStatus = new Map<string, string>();
    for (const { event } of events) {
      if (event.type === "upsert" && event.status) finalStatus.set(event.id, event.status);
    }
    expect(Object.fromEntries(finalStatus)).toEqual({
      call_277173: "completed",
      call_277176: "completed",
      call_277179: "completed",
    });
  });
  test.each(["subagent-notification", "subagent-update"])(
    "completes turn-limited children in a grouped %s",
    (customType) => {
      const host = createPiExtensionHost();
      for (const id of ["1", "2", "3"]) {
        host.mapToolCall({
          callId: `call-${id}`,
          toolName: "Agent",
          args: { subagent_type: "Explore", prompt: "Inspect" },
          status: "completed",
          result: { details: { agentId: `native-${id}`, status: "background" } },
        });
      }
      const mapping = host.mapCustomMessage({
        role: "custom",
        customType,
        content: "Wrapped up (turn limit)",
        display: true,
        timestamp: 0,
        details: {
          id: "native-1",
          status: "steered",
          others: [
            { id: "native-2", status: "steered" },
            { id: "native-3", status: "running" },
          ],
        },
      });
      expect(mapping?.subagents).toEqual([
        expect.objectContaining({ id: "call-1", status: "completed" }),
        expect.objectContaining({ id: "call-2", status: "completed" }),
        expect.objectContaining({ id: "call-3", status: "running" }),
      ]);
    },
  );
  test.each(["get_subagent_result", "steer_subagent"])(
    "completes a turn-limited child when collected through %s",
    (toolName) => {
      const host = createPiExtensionHost();
      host.mapToolCall({
        callId: "call-1",
        toolName: "Agent",
        args: { subagent_type: "Explore", prompt: "Inspect" },
        status: "completed",
        result: { details: { agentId: "native-1", status: "background" } },
      });
      const mapping = host.mapToolCall({
        callId: "followup-1",
        toolName,
        args: { agent_id: "native-1" },
        status: "completed",
        result: {
          details: { agentId: "native-1", status: "steered" },
          content: [{ type: "text", text: "Wrapped up (turn limit)" }],
        },
      });
      expect(mapping?.subagents).toEqual([{ type: "upsert", id: "call-1", status: "completed" }]);
      expect(mapping?.detail).toEqual({
        type: "sub_agent",
        description: undefined,
        log: "",
      });
    },
  );
  // get_subagent_result returns text only (no `details`) and suppresses the completion
  // notification, so its header is the only completion record for a collected child.
  test.each([
    ["completed", "", "completed"],
    ["steered", " (wrapped up at the turn limit — output may be partial)", "completed"],
    ["error", "", "failed"],
    ["running", "", "running"],
  ])("maps a text-only get_subagent_result with status %s", (raw, note, expected) => {
    const host = createPiExtensionHost();
    host.mapToolCall({
      callId: "call-1",
      toolName: "Agent",
      args: { subagent_type: "Explore", prompt: "Inspect" },
      status: "completed",
      result: { details: { agentId: "e4537d05-d56f-411", status: "background" } },
    });
    const mapping = host.mapToolCall({
      callId: "followup-1",
      toolName: "get_subagent_result",
      // The tool also accepts a handle such as the agent's name.
      args: { agent_id: "explore", wait: true },
      status: "completed",
      result: {
        content: [
          {
            type: "text",
            text:
              "Agent: e4537d05-d56f-411\n" +
              `Type: Explore | Status: ${raw}${note} | Tool uses: 3 | Duration: 12s\n` +
              "Description: Inspect\n\nDone.",
          },
        ],
      },
    });
    expect(mapping?.subagents).toEqual([{ type: "upsert", id: "call-1", status: expected }]);
  });
  test("replays a background child collected through get_subagent_result as completed", async () => {
    const messages: PiAgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "Agent",
            arguments: { subagent_type: "Explore", prompt: "Inspect", run_in_background: true },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "Agent",
        content: [{ type: "text", text: "Agent started in background.\nAgent ID: native-1\n" }],
        details: { agentId: "native-1", status: "background" },
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "followup-1",
            name: "get_subagent_result",
            arguments: { agent_id: "native-1", wait: true },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "followup-1",
        toolName: "get_subagent_result",
        content: [
          {
            type: "text",
            text: "Agent: native-1\nType: Explore | Status: completed | Duration: 1s\nDescription: Inspect\n\nDone.",
          },
        ],
      },
    ];
    const statuses: string[] = [];
    for await (const event of streamPiHistory("pi", messages)) {
      if (event.type === "provider_subagent" && event.event.type === "upsert" && event.event.status)
        statuses.push(event.event.status);
    }
    expect(statuses.at(-1)).toBe("completed");
  });
  test.each([
    ["background", "running"],
    ["queued", "running"],
    ["running", "running"],
    ["completed", "completed"],
    ["error", "failed"],
    ["aborted", "canceled"],
    ["stopped", "canceled"],
    ["unknown", "running"],
  ])("preserves the mapping of %s to %s", (status, expected) => {
    const mapping = createPiExtensionHost().mapToolCall({
      callId: "call-1",
      toolName: "Agent",
      args: { subagent_type: "Explore", prompt: "Inspect" },
      status: "completed",
      result: { details: { agentId: "native-1", status } },
    });
    expect(mapping?.subagents).toEqual([
      expect.objectContaining({ id: "call-1", status: expected }),
    ]);
  });
  test("completes a turn-limited background child live and on history replay", async () => {
    const path = new URL("./fixtures/background.json", import.meta.url);
    const source = readSubagentFixture(path);
    const notification = source.messages.find((message) => message.role === "custom");
    const notificationDetails = notification?.details;
    if (
      !notificationDetails ||
      typeof notificationDetails !== "object" ||
      !("outputFile" in notificationDetails) ||
      typeof notificationDetails.outputFile !== "string"
    ) {
      throw new Error("Background fixture is missing its child output file");
    }
    const fixture = readSubagentFixture(path, {
      from: notificationDetails.outputFile,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    function wrapUp(message: PiAgentMessage): PiAgentMessage {
      if (message.role !== "custom") return message;
      const details = message.details;
      if (!details || typeof details !== "object") {
        throw new Error("Background fixture is missing its notification details");
      }
      return {
        ...message,
        content: "Wrapped up (turn limit)",
        details: { ...details, status: "steered" },
      };
    }
    const events = await verifySubagentFixture({
      ...fixture,
      events: fixture.events.map((event) =>
        event.type === "message_end" ? { ...event, message: wrapUp(event.message) } : event,
      ),
      messages: fixture.messages.map(wrapUp),
    });
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
});
