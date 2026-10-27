import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { InteractiveResponseStore } from "./interactive-responses.js";
let directory: string;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("persists documents, detects concurrent writes and freezes submitted choices across restart", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-ui-"));
  const store = new InteractiveResponseStore(directory);
  const document = await store.create("agent", {
    title: "Plan",
    summary: "Choose",
    source: 'root = Layout([Selection("plan", "Plan", ["A", "B"])])',
  });
  const [a, b] = await Promise.allSettled([
    store.update("agent", document.id, 0, { plan: "A" }),
    store.update("agent", document.id, 0, { plan: "B" }),
  ]);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("rejected");
  const reference = { documentId: document.id, revision: 1 };
  const frozen = await store.snapshot("agent", reference, "message");
  await store.update("agent", document.id, 1, { plan: "B" });
  await store.freezeContext(
    "agent",
    "deepen-message",
    "response-1",
    "original response and choices",
  );
  const restarted = new InteractiveResponseStore(directory);
  expect(
    await restarted.freezeContext("agent", "deepen-message", "response-1", "modified choices"),
  ).toBe("original response and choices");
  expect((await restarted.get("agent", document.id)).state).toEqual({ plan: "B" });
  expect(await restarted.snapshot("agent", reference, "message")).toEqual(frozen);
  expect(frozen.state).toEqual({ plan: "A" });
  await expect(restarted.get("other", document.id)).rejects.toThrow();
  expect((await restarted.snapshot("agent", reference, "new-message")).state).toEqual({
    plan: "A",
  });
  expect(
    (await restarted.snapshot("agent", { documentId: document.id, revision: 0 }, "queued-message"))
      .state,
  ).toEqual({});
  await expect(
    restarted.snapshot("agent", { documentId: document.id, revision: 99 }, "future-message"),
  ).rejects.toThrow(/revision/i);
});

it("restores custom visual state and preserves the confirmed revision after process recreation", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-ui-script-"));
  const store = new InteractiveResponseStore(directory);
  const document = await store.create("agent", {
    title: "Calculator",
    summary: "Choose",
    source: 'root = Layout([HtmlArtifact("<p>Calculator</p>")])',
  });
  const selected = { artifact: JSON.stringify({ state: { count: 3 }, proposal: "Choose 3" }) };
  await store.update("agent", document.id, 0, selected);
  const restarted = new InteractiveResponseStore(directory);
  expect((await restarted.get("agent", document.id)).state).toEqual(selected);
  await restarted.update("agent", document.id, 1, {
    artifact: JSON.stringify({ state: { count: 4 }, proposal: "Choose 4" }),
  });
  expect(
    (
      await restarted.snapshot(
        "agent",
        { documentId: document.id, revision: 1 },
        "queued-script-choice",
      )
    ).state,
  ).toEqual(selected);
});

it("restores submitted display text by provider identity without crossing agents", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-ui-messages-"));
  const store = new InteractiveResponseStore(directory);
  const message = {
    type: "user_message" as const,
    text: "Valider 9",
    clientMessageId: "client",
    messageId: "client",
  };
  await store.rememberSubmittedMessage("agent", "provider", message);
  const restarted = new InteractiveResponseStore(directory);
  expect(await restarted.submittedMessages("agent")).toEqual({ provider: message });
  expect(await restarted.submittedMessages("other")).toEqual({});
});
