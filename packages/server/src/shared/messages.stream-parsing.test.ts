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
  it("parses legacy inProgress tool_call snapshots and normalizes status", () => {
    const fixture = loadFixture("legacy-agent-stream-snapshot-inProgress.json");
    const parsed = AgentStreamSnapshotMessageSchema.parse(fixture);

    const first = parsed.payload.events[0]?.event;
    expect(first?.type).toBe("timeline");
    if (first?.type === "timeline" && first.item.type === "tool_call") {
      expect(first.item.status).toBe("running");
      expect(first.item.error).toBeNull();
      expect(first.item.output).toBeNull();
    }
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
            input: { command: "ls" },
            output: null,
            error: null,
            detail: {
              type: "shell",
              command: "ls",
            },
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

  it("parses websocket envelope for agent_stream_snapshot with legacy status", () => {
    const fixture = loadFixture("legacy-agent-stream-snapshot-inProgress.json") as {
      type: "agent_stream_snapshot";
      payload: unknown;
    };

    const wrapped = WSOutboundMessageSchema.parse({
      type: "session",
      message: fixture,
    });

    if (wrapped.type === "session" && wrapped.message.type === "agent_stream_snapshot") {
      const first = wrapped.message.payload.events[0]?.event;
      expect(first?.type).toBe("timeline");
      if (first?.type === "timeline" && first.item.type === "tool_call") {
        expect(first.item.status).toBe("running");
        expect(first.item.error).toBeNull();
      }
    }
  });
});
