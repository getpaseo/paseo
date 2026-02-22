import { describe, expect, it } from "vitest";
import { buildDraftStoreKey } from "./draft-keys";

describe("buildDraftStoreKey", () => {
  it("isolates agent drafts by server and agent ids", () => {
    const keyA = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "agent-1",
    });
    const keyB = buildDraftStoreKey({
      serverId: "server-b",
      agentId: "agent-1",
    });
    const keyC = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "agent-2",
    });

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
    expect(keyB).not.toBe(keyC);
  });

  it("uses draftId keyspace for create flow drafts", () => {
    const key = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "__new_agent__",
      draftId: "draft-123",
    });

    expect(key).toBe("draft:server-a:draft-123");
  });
});
