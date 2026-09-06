import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ASSISTANT_CONFIGURATION } from "@getpaseo/protocol/assistants";
import { AssistantStore } from "./assistant-store.js";

describe("AssistantStore", () => {
  let dir: string;
  let store: AssistantStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-assistants-"));
    store = new AssistantStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("copies templates and restores separate instances after a restart", async () => {
    const template = await store.saveTemplate("owner", {
      name: "Chief of staff",
      configuration: { ...DEFAULT_ASSISTANT_CONFIGURATION, context: "Project Iris" },
    });
    const first = await store.create("owner", { name: "Work", templateId: template.id });
    const second = await store.create("owner", { name: "Personal", templateId: template.id });
    await store.saveTemplate("owner", {
      templateId: template.id,
      expectedRevision: template.revision,
      name: template.name,
      configuration: { ...template.configuration, context: "Changed template" },
    });
    await store.deleteTemplate("owner", template.id);
    const restored = new AssistantStore(dir);
    expect((await restored.get("owner", first.id)).assistant.configuration.context).toBe(
      "Project Iris",
    );
    expect((await restored.list("owner")).map((a) => a.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(await restored.listTemplates("owner")).toEqual([]);
  });

  it("isolates templates, history, and instance mutations by principal", async () => {
    const template = await store.saveTemplate("alice", {
      name: "Private",
      configuration: DEFAULT_ASSISTANT_CONFIGURATION,
    });
    const assistant = await store.create("alice", { name: "Private", templateId: template.id });
    expect(await store.list("bob")).toEqual([]);
    expect(await store.listTemplates("bob")).toEqual([]);
    await expect(store.get("bob", assistant.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      store.create("bob", { name: "Copy", templateId: template.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(store.openCall("bob", assistant.id, "call", () => {})).rejects.toMatchObject({
      code: "not_found",
    });
    await store.delete("bob", assistant.id);
    expect((await store.get("alice", assistant.id)).assistant.name).toBe("Private");
  });

  it("rejects path traversal and stale edits", async () => {
    await expect(store.get("owner", "../../outside")).rejects.toThrow();
    const assistant = await store.create("owner", { name: "Work" });
    await store.update("owner", {
      assistantId: assistant.id,
      expectedRevision: 1,
      name: "Renamed",
      configuration: assistant.configuration,
    });
    await expect(
      store.update("owner", {
        assistantId: assistant.id,
        expectedRevision: 1,
        name: "Stale",
        configuration: assistant.configuration,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("journals ordered calls, pages history, and compacts without deleting the original", async () => {
    const assistant = await store.create("owner", { name: "Work" });
    const call = await store.openCall("owner", assistant.id, "call-1", () => {});
    await Promise.all([
      call.append({ kind: "transcript", role: "user", text: "Remember Iris" }),
      call.append({ kind: "transcript", role: "assistant", text: "Iris" }),
    ]);
    await call.close("requested");
    const compacted = await store.compact("owner", {
      assistantId: assistant.id,
      expectedRevision: 1,
      throughSeq: 3,
      summary: "The project is Iris.",
    });
    expect(compacted.summaryThroughSeq).toBe(3);
    const restored = new AssistantStore(dir);
    const page = await restored.get("owner", assistant.id, { limit: 2 });
    expect(page.history.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(page.hasMore).toBe(true);
    const older = await restored.get("owner", assistant.id, { beforeSeq: 3, limit: 2 });
    expect(older.history.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(older.hasMore).toBe(false);
    const next = await restored.openCall("owner", assistant.id, "call-2", () => {});
    expect(next.assistant.summary).toBe("The project is Iris.");
    expect(
      next.history.some((entry) => entry.kind === "transcript" && entry.text === "Remember Iris"),
    ).toBe(true);
    await next.close("requested");
  });

  it("permits next-call configuration edits but refuses simultaneous calls", async () => {
    const assistant = await store.create("owner", { name: "Work" });
    const first = await store.openCall("owner", assistant.id, "call-1", () => {});
    await expect(store.openCall("owner", assistant.id, "call-2", () => {})).rejects.toMatchObject({
      code: "assistant_busy",
    });
    await store.update("owner", {
      assistantId: assistant.id,
      expectedRevision: 1,
      name: "Next",
      configuration: { ...assistant.configuration, instructions: "New instructions" },
    });
    expect(first.assistant.configuration.instructions).toBe("");
    await first.close("requested");
    const next = await store.openCall("owner", assistant.id, "call-3", () => {});
    expect(next.assistant.configuration.instructions).toBe("New instructions");
    await next.close("requested");
  });

  it("drains pending history and closes only its own call on deletion", async () => {
    const assistant = await store.create("owner", { name: "Work" });
    let closed = 0;
    const call = await store.openCall("owner", assistant.id, "call-1", () => {
      closed++;
    });
    const writing = call.append({ kind: "transcript", role: "user", text: "Pending" });
    await store.delete("owner", assistant.id);
    await writing;
    await call.append({ kind: "transcript", role: "assistant", text: "Late" });
    await call.close("requested");
    expect(closed).toBe(1);
    expect(await store.list("owner")).toEqual([]);
    await expect(store.get("owner", assistant.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("marks a call interrupted by daemon restart and retains archived history", async () => {
    const assistant = await store.create("owner", { name: "Long-lived" });
    const oldCall = await store.openCall("owner", assistant.id, "old-call", () => {});
    await Promise.all(
      Array.from({ length: 513 }, (_, index) =>
        oldCall.append({ kind: "transcript", role: "user", text: `Message ${index}` }),
      ),
    );
    const restarted = new AssistantStore(dir);
    const next = await restarted.openCall("owner", assistant.id, "new-call", () => {});
    await next.close("requested");
    const oldPage = await restarted.get("owner", assistant.id, { beforeSeq: 10, limit: 20 });
    expect(oldPage.history.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const latest = await restarted.get("owner", assistant.id);
    expect(latest.history).toEqual(
      expect.arrayContaining([
        {
          kind: "call_ended",
          callId: "old-call",
          seq: 515,
          createdAt: expect.any(String),
          cause: "daemon_restarted",
        },
      ]),
    );
    await restarted.delete("owner", assistant.id);
    expect(await restarted.list("owner")).toEqual([]);
  });
});
