import { describe, expect, it } from "vitest";
import {
  UiStateClearRequestMessageSchema,
  UiStateGetRequestMessageSchema,
  UiStateListRequestMessageSchema,
  UiStateUpdatedMessageSchema,
  UiStateUpsertRequestMessageSchema,
  UiStateUpsertResponseMessageSchema,
} from "./schemas.js";

describe("ui_state wire", () => {
  it("parses get request", () => {
    const parsed = UiStateGetRequestMessageSchema.parse({
      type: "ui_state.get.request",
      requestId: "r1",
      namespace: "composer",
      key: "agent:agt_1",
    });
    expect(parsed.key).toBe("agent:agt_1");
    expect(parsed.namespace).toBe("composer");
  });

  it("rejects empty key on upsert", () => {
    expect(() =>
      UiStateUpsertRequestMessageSchema.parse({
        type: "ui_state.upsert.request",
        requestId: "r1",
        namespace: "composer",
        key: "",
        record: { text: "hi", updatedAt: "2026-08-01T00:00:00.000Z" },
      }),
    ).toThrow();
  });

  it("parses upsert request with composer text", () => {
    const parsed = UiStateUpsertRequestMessageSchema.parse({
      type: "ui_state.upsert.request",
      requestId: "r2",
      namespace: "composer",
      key: "agent:agt_1",
      record: {
        text: "hello from desktop",
        lifecycle: "active",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(parsed.record.text).toBe("hello from desktop");
  });

  it("parses upsert response with applied false", () => {
    const parsed = UiStateUpsertResponseMessageSchema.parse({
      type: "ui_state.upsert.response",
      payload: {
        requestId: "r2",
        namespace: "composer",
        key: "agent:agt_1",
        applied: false,
        record: { text: "newer", updatedAt: "2026-08-01T01:00:00.000Z" },
        error: null,
      },
    });
    expect(parsed.payload.applied).toBe(false);
  });

  it("parses clear request", () => {
    const parsed = UiStateClearRequestMessageSchema.parse({
      type: "ui_state.clear.request",
      requestId: "r3",
      namespace: "review",
      key: "review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false",
      updatedAt: "2026-08-01T00:00:01.000Z",
    });
    expect(parsed.namespace).toBe("review");
  });

  it("parses list request with optional keyPrefix", () => {
    const parsed = UiStateListRequestMessageSchema.parse({
      type: "ui_state.list.request",
      requestId: "r4",
      namespace: "composer",
      keyPrefix: "agent:",
    });
    expect(parsed.keyPrefix).toBe("agent:");
  });

  it("parses updated push with null record (cleared)", () => {
    const parsed = UiStateUpdatedMessageSchema.parse({
      type: "ui_state.updated",
      namespace: "review",
      key: "review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false",
      record: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(parsed.record).toBeNull();
  });

  it("parses review comments on record", () => {
    const parsed = UiStateUpsertRequestMessageSchema.parse({
      type: "ui_state.upsert.request",
      requestId: "r5",
      namespace: "review",
      key: "review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false",
      record: {
        comments: [
          {
            id: "c1",
            filePath: "src/a.ts",
            side: "new",
            lineNumber: 12,
            body: "nit",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(parsed.record.comments?.[0]?.body).toBe("nit");
  });
});
