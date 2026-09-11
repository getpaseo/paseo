import { CodexProviderOptionsSchema } from "../providers/codex/options.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { AgentManager, type AgentManagerEvent } from "../agent-manager.js";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import { projectTimelineRows } from "../timeline-projection.js";
import { ToolCallSummaryStore } from "./store.js";
import type { ToolCallSummaryTarget } from "./types.js";
import {
  readToolCallSummary,
  readToolCallSummaryFilePath,
} from "@getpaseo/protocol/tool-call-summary";
import { AgentSummaryGenerator } from "./generation.js";
import { summaryCall } from "./prompt.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-summary-integration-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const logger = pino({ level: "silent" });
  const store = new ToolCallSummaryStore(path.join(dir, "summaries"), logger);
  const targets: ToolCallSummaryTarget[] = [];
  const inputTargets: ToolCallSummaryTarget[] = [];
  const client = createTestAgentClient("codex");
  const manager = new AgentManager({
    clients: { codex: client },
    providerDefinitions: {
      codex: {
        enabled: true,
        validateOptions: (options) =>
          options === undefined ? undefined : CodexProviderOptionsSchema.parse(options),
      },
    },
    logger,
    toolCallSummaryStore: store,
    onToolCallSummaryRequested: (target) =>
      (target.phase === "input" ? inputTargets : targets).push(target),
  });
  const source = await manager.createAgent(
    { provider: "codex", cwd: dir, modeId: "full-access" },
    undefined,
    { workspaceId: undefined },
  );
  cleanup.push(() => manager.closeAgent(source.id));
  await manager.runAgent(source.id, "echo hello");
  return { dir, logger, store, targets, inputTargets, manager, source, client };
}

describe("tool-call descriptions in the real manager", () => {
  it("keeps the input label when its request finishes after the tool result", async () => {
    const { manager, targets, inputTargets, source } = await setup();
    expect(inputTargets).toHaveLength(1);
    expect(targets).toHaveLength(1);
    await manager.applyToolCallSummary(targets[0], "Printed a greeting");
    await manager.applyToolCallSummary(inputTargets[0], "Run greeting command", "/tmp/greeting.sh");
    const projected = projectTimelineRows({
      rows: await manager.getTimelineRows(source.id),
      mode: "projected",
    });
    const calls = projected.filter((entry) => entry.item.type === "tool_call");
    expect(calls).toHaveLength(1);
    expect(readToolCallSummary(calls[0].item.metadata, "input")).toBe("Run greeting command");
    expect(readToolCallSummaryFilePath(calls[0].item.metadata, "input")).toBe("/tmp/greeting.sh");
    expect(readToolCallSummary(calls[0].item.metadata)).toBe("Printed a greeting");
  });

  it("publishes a sequenced update without duplicating the projected tool call or changing activity", async () => {
    const { manager, targets, source } = await setup();
    expect(targets).toHaveLength(1);
    const updatedAt = manager.getAgent(source.id)?.updatedAt;
    const events: AgentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event), { agentId: source.id, replayState: false });
    await manager.applyToolCallSummary(targets[0], "Printed a greeting successfully.");
    expect(targets).toHaveLength(1);
    expect(manager.getAgent(source.id)?.updatedAt).toEqual(updatedAt);
    expect(events).toHaveLength(1);
    const projected = projectTimelineRows({
      rows: await manager.getTimelineRows(source.id),
      mode: "projected",
    });
    const calls = projected.filter((entry) => entry.item.type === "tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0].item.type === "tool_call" && readToolCallSummary(calls[0].item.metadata)).toBe(
      "Printed a greeting successfully.",
    );
  });

  it("reattaches saved descriptions after restart without scheduling history", async () => {
    const { manager, targets, source, dir, logger, client } = await setup();
    await manager.applyToolCallSummary(targets[0], "Printed a greeting.");
    const handle = manager.getAgent(source.id)?.persistence;
    if (!handle) throw new Error("Expected provider persistence");
    await manager.closeAgent(source.id);
    const restoredTargets: ToolCallSummaryTarget[] = [];
    const restored = new AgentManager({
      clients: { codex: client },
      logger,
      toolCallSummaryStore: new ToolCallSummaryStore(path.join(dir, "summaries"), logger),
      onToolCallSummaryRequested: (target) => restoredTargets.push(target),
    });
    await restored.resumeAgentFromPersistence(handle, { provider: "codex", cwd: dir }, source.id);
    cleanup.push(() => restored.closeAgent(source.id));
    await restored.hydrateTimelineFromProvider(source.id);
    const calls = restored
      .getTimeline(source.id)
      .filter((item) => item.type === "tool_call" && item.status === "completed");
    expect(calls).toHaveLength(1);
    expect(readToolCallSummary(calls[0].metadata)).toBe("Printed a greeting.");
    expect(restoredTargets).toEqual([]);
  });

  it("rejects results from an obsolete timeline epoch", async () => {
    const { manager, targets, source, store } = await setup();
    await manager.hydrateTimelineFromProvider(source.id, { force: true });
    await manager.applyToolCallSummary(targets[0], "Obsolete description.");
    expect(store.recent(source.id)).toEqual([]);
  });

  it("ignores results after source closure", async () => {
    const { manager, targets, source, store } = await setup();
    await manager.closeAgent(source.id);
    await manager.applyToolCallSummary(targets[0], "Too late.");
    expect(store.recent(source.id)).toEqual([]);
  });

  it("reuses an internal helper, excludes Paseo tools, and closes on invalidation", async () => {
    const { manager, targets, source, store, logger, client } = await setup();
    const created = vi.spyOn(client, "createSession");
    const run = vi.spyOn(manager, "runAgent").mockImplementation(async (id) => ({
      sessionId: id,
      timeline: [],
      finalText: JSON.stringify({
        descriptions: [{ id: targets[0].key, description: "Printed a greeting." }],
      }),
    }));
    const generator = new AgentSummaryGenerator({
      manager,
      store,
      logger,
      readDaemonConfig: () => ({
        metadataGeneration: { providers: [{ provider: "codex", model: "gpt-5.4-mini" }] },
      }),
      providerSnapshotManager: {
        listProviders: async () => [
          { provider: "codex", enabled: true, status: "ready", models: [] },
        ],
      },
    });
    cleanup.push(() => generator.dispose());
    const callSource = manager.getToolCallSummarySource(targets[0]);
    if (!callSource) throw new Error("Missing source");
    const calls = [summaryCall(targets[0].key, callSource)];
    await generator.generate(source.id, calls, 0, new AbortController().signal);
    await generator.generate(source.id, calls, 0, new AbortController().signal);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toMatchObject({ internal: true, mcpServers: {} });
    expect(created.mock.calls[0][1]?.paseoTools).toBeUndefined();
    expect(run.mock.calls[0][0]).toBe(run.mock.calls[1][0]);
    expect(run.mock.calls[0][1]).toContain("Context (source material)");
    expect(run.mock.calls[1][1]).not.toContain("Context (source material)");
    for (let batch = 2; batch < 21; batch++)
      await generator.generate(source.id, calls, 0, new AbortController().signal);
    expect(created).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[20][0]).not.toBe(run.mock.calls[0][0]);
    const helperId = run.mock.calls[20][0];
    await generator.invalidate(source.id);
    expect(manager.getAgent(helperId)).toBeNull();

    vi.useFakeTimers();
    try {
      const helperIds: string[] = [];
      for (let conversation = 0; conversation < 4; conversation++) {
        const additionalSource = await manager.createAgent(
          { provider: "codex", cwd: source.cwd },
          undefined,
          { workspaceId: undefined },
        );
        cleanup.push(() => manager.closeAgent(additionalSource.id));
        await generator.generate(additionalSource.id, calls, 0, new AbortController().signal);
        const lastRun = run.mock.calls.at(-1);
        if (!lastRun) throw new Error("Expected helper run");
        helperIds.push(lastRun[0]);
      }
      expect(manager.getAgent(helperIds[0])).toBeNull();
      expect(helperIds.slice(1).map((id) => manager.getAgent(id)?.internal)).toEqual([
        true,
        true,
        true,
      ]);
      await vi.advanceTimersByTimeAsync(120000);
      expect(helperIds.map((id) => manager.getAgent(id))).toEqual([null, null, null, null]);
    } finally {
      vi.useRealTimers();
    }
  });
});
