import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AgentStreamMessageSchema,
  AgentStreamSnapshotMessageSchema,
  WSOutboundMessageSchema,
} from "./messages.js";

function loadFixture(name: string): unknown {
  const url = new URL(`./__fixtures__/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("shared messages stream parsing", () => {
  it("rejects legacy inProgress tool_call snapshots", () => {
    const fixture = loadFixture("legacy-agent-stream-snapshot-inProgress.json");
    const parsed = AgentStreamSnapshotMessageSchema.safeParse(fixture);
    expect(parsed.success).toBe(false);
  });

  it("parses representative agent_stream tool_call event", () => {
    const parsed = AgentStreamMessageSchema.parse({
      type: "agent_stream",
      payload: {
        agentId: "agent_live",
        timestamp: "2026-02-08T20:10:00.000Z",
        event: {
          type: "timeline",
          provider: "claude",
          item: {
            type: "tool_call",
            callId: "call_live",
            name: "shell",
            status: "running",
            detail: {
              type: "shell",
              command: "ls",
            },
            error: null,
          },
        },
      },
    });

    expect(parsed.payload.event.type).toBe("timeline");
    if (parsed.payload.event.type === "timeline") {
      expect(parsed.payload.event.item.type).toBe("tool_call");
      if (parsed.payload.event.item.type === "tool_call") {
        expect(parsed.payload.event.item.status).toBe("running");
      }
    }
  });

  it("rejects websocket envelope for agent_stream_snapshot with legacy status", () => {
    const fixture = loadFixture("legacy-agent-stream-snapshot-inProgress.json") as {
      type: "agent_stream_snapshot";
      payload: unknown;
    };

    const wrapped = WSOutboundMessageSchema.safeParse({
      type: "session",
      message: fixture,
    });
    expect(wrapped.success).toBe(false);
  });
});
