import { describe, expect, it } from "vitest";

import { applyHostPromptQueue, hostOwnsPromptQueue } from "./host-prompt-queue";

describe("host prompt queue mirror", () => {
  it("leaves a local queue alone when the daemon has no queue field", () => {
    const current = new Map([["agent", [{ id: "local", text: "stay", attachments: [] }]]]);

    expect(applyHostPromptQueue(current, "agent", undefined)).toBeNull();
    expect(hostOwnsPromptQueue(undefined)).toBe(false);
    expect(hostOwnsPromptQueue({ promptQueue: true })).toBe(true);
  });

  it("replaces the local queue with the host order and keeps known attachments", () => {
    const image = {
      kind: "image" as const,
      metadata: {
        id: "img",
        mimeType: "image/png",
        storageType: "web-indexeddb" as const,
        storageKey: "img",
        createdAt: 0,
      },
    };
    const current = new Map([["agent", [{ id: "one", text: "old", attachments: [image] }]]]);

    const next = applyHostPromptQueue(current, "agent", [
      { id: "one", text: "first" },
      { id: "two", text: "second" },
    ]);

    expect(next?.get("agent")).toEqual([
      { id: "one", text: "first", attachments: [image] },
      { id: "two", text: "second", attachments: [] },
    ]);
  });

  it("clears the local queue when the host queue is empty", () => {
    const current = new Map([["agent", [{ id: "one", text: "first", attachments: [] }]]]);

    expect(applyHostPromptQueue(current, "agent", [])?.get("agent")).toEqual([]);
  });
});
