import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { readToolCallSummary } from "@getpaseo/protocol/tool-call-summary";
import { ToolCallSummaryStore, toolCallSummaryKey } from "./store.js";

const directories: string[] = [];
const item: ToolCallTimelineItem = {
  type: "tool_call",
  callId: "call-1",
  name: "shell",
  status: "completed",
  error: null,
  detail: { type: "shell", command: "npm run typecheck", output: "Passed", exitCode: 0 },
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-summaries-"));
  directories.push(dir);
  return { dir, store: new ToolCallSummaryStore(dir, pino({ level: "silent" })) };
}

describe("tool-call summary persistence", () => {
  it("preserves input labels across output changes and restart, but clears them for changed input", async () => {
    const { dir, store } = await setup();
    const running: ToolCallTimelineItem = {
      ...item,
      status: "running",
      detail: { type: "shell", command: "npm run typecheck" },
    };
    await store.save("agent", toolCallSummaryKey(running, "input"), "Check project types");
    const restored = new ToolCallSummaryStore(dir, pino({ level: "silent" }));
    await restored.load("agent");
    expect(toolCallSummaryKey(running, "input")).toBe(toolCallSummaryKey(item, "input"));
    expect(readToolCallSummary(restored.enrich("agent", item).metadata, "input")).toBe(
      "Check project types",
    );
    expect(
      readToolCallSummary(
        restored.enrich("agent", { ...item, detail: { type: "shell", command: "npm test" } })
          .metadata,
        "input",
      ),
    ).toBeUndefined();
  });

  it("restores descriptions only for identical terminal calls after restart", async () => {
    const { dir, store } = await setup();
    await store.save(
      "agent",
      toolCallSummaryKey(item),
      "Checked the project's types successfully.",
    );
    const restored = new ToolCallSummaryStore(dir, pino({ level: "silent" }));
    await restored.load("agent");
    const enriched = restored.enrich("agent", item);
    expect(enriched.type === "tool_call" && readToolCallSummary(enriched.metadata)).toBe(
      "Checked the project's types successfully.",
    );
    const changed = { ...item, detail: { type: "shell" as const, command: "npm test" } };
    expect(restored.enrich("agent", changed)).toEqual({
      ...changed,
      metadata: { "paseo.toolCallSummary": null, "paseo.toolCallInputSummary": null },
    });
  });
  it("serializes concurrent writes and removes discarded history", async () => {
    const { store } = await setup();
    await Promise.all([store.save("agent", "one", "One."), store.save("agent", "two", "Two.")]);
    expect(store.recent("agent")).toEqual(["One.", "Two."]);
    await store.retain("agent", new Set(["two"]));
    expect(store.recent("agent")).toEqual(["Two."]);
    await store.delete("agent");
    await store.load("agent");
    expect(store.recent("agent")).toEqual([]);
  });
});
