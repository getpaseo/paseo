import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("inventory message schema parity", () => {
  test("SessionInboundMessageSchema accepts a valid inventory.sessions.request", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "inventory.sessions.request",
      requestId: "req-1",
      snapshot_id: "snap-1",
      cursor: "cursor-1",
      limit: 50,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe("inventory.sessions.request");
    expect(parsed.data.requestId).toBe("req-1");
    expect(parsed.data.snapshot_id).toBe("snap-1");
    expect(parsed.data.cursor).toBe("cursor-1");
    expect(parsed.data.limit).toBe(50);
  });

  test("SessionInboundMessageSchema rejects an unknown inventory type", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "inventory.unknown.request",
      requestId: "req-1",
    });
    expect(parsed.success).toBe(false);
  });

  test("SessionInboundMessageSchema rejects an inventory.sessions.request with an out-of-range limit", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "inventory.sessions.request",
      requestId: "req-1",
      limit: 250,
    });
    expect(parsed.success).toBe(false);
  });

  test("SessionOutboundMessageSchema accepts a valid inventory.sessions.response", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "inventory.sessions.response",
      payload: {
        requestId: "req-1",
        schema_version: "paseo.inventory_sessions.v1",
        snapshot_id: "snap-1",
        entries: [
          {
            backend: "paseo",
            native_id: "agent-1",
            provider: "claude",
            status_raw: "idle",
            archived: false,
            archived_at: null,
            internal: false,
            live: true,
            cwd: "/tmp/agent-1",
            created_at: "2026-08-10T00:00:00.000Z",
            updated_at: "2026-08-10T00:00:00.000Z",
            persistence_session_id: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe("inventory.sessions.response");
    expect(parsed.data.payload.snapshot_id).toBe("snap-1");
    expect(parsed.data.payload.has_more).toBe(false);
  });

  test("SessionOutboundMessageSchema rejects a malformed inventory.sessions.response payload", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "inventory.sessions.response",
      payload: {
        requestId: "req-1",
        schema_version: "paseo.inventory_sessions.v1",
        // Missing snapshot_id
        entries: [],
        next_cursor: null,
        has_more: false,
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("SessionOutboundMessageSchema rejects a corrupted entry inside the inventory response", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "inventory.sessions.response",
      payload: {
        requestId: "req-1",
        schema_version: "paseo.inventory_sessions.v1",
        snapshot_id: "snap-1",
        entries: [
          {
            backend: "paseo",
            native_id: "",
            provider: "claude",
            status_raw: "idle",
            archived: false,
            archived_at: null,
            internal: false,
            live: true,
            cwd: "/tmp/agent-1",
            created_at: "2026-08-10T00:00:00.000Z",
            updated_at: "2026-08-10T00:00:00.000Z",
            persistence_session_id: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      },
    });
    expect(parsed.success).toBe(false);
  });
});
