import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createPiExtensionHost } from "../index.js";
import { streamPiHistory } from "../../history-mapper.js";
import type { AgentStreamEvent } from "../../../../agent-sdk-types.js";
import { ProviderSubagentStore } from "../../../../provider-subagents/store.js";
import { PiCustomEntrySchema } from "../../rpc-types.js";

function progress(data: Record<string, unknown>) {
  return {
    type: "custom" as const,
    id: "entry-1",
    customType: "pi-dynamic-workflows:progress",
    timestamp: "2026-09-28T10:00:00.000Z",
    data: {
      version: 1,
      runId: "run-1",
      name: "Review",
      status: "running",
      cwd: "/project",
      agentCount: 1,
      runningCount: 1,
      doneCount: 0,
      errorCount: 0,
      agentIds: [0],
      agents: [{ id: 0, label: "Reviewer", status: "running", promptPreview: "Review the patch" }],
      ...data,
    },
  };
}

describe("pi-dynamic-workflows adapter", () => {
  test("maps captured real Pi background progress to the same native tree live and after replay", async () => {
    const fixture = z
      .object({
        events: z.array(
          z.object({ type: z.literal("entry_appended"), entry: PiCustomEntrySchema }),
        ),
      })
      .parse(
        JSON.parse(readFileSync(new URL("./fixtures/background.json", import.meta.url), "utf8")),
      );
    const entries = fixture.events.map((event) => event.entry);
    const run = z.object({ runId: z.string() }).parse(entries[0]?.data);
    const id = `workflow:${run.runId}`;
    const host = createPiExtensionHost();
    const live = entries.flatMap((entry) => host.mapCustomEntry(entry)?.events ?? []);
    const replay: AgentStreamEvent[] = [];
    for await (const event of streamPiHistory("pi", [], [], {}, undefined, undefined, entries))
      replay.push(event);
    expect(replay).toEqual(live);
    const store = new ProviderSubagentStore();
    for (const event of live) {
      if (event.type === "provider_subagent") store.apply("parent", event.provider, event.event);
    }
    expect(
      store.list("parent").map(({ title, status, parentSubagentId, subtitle }) => ({
        title,
        status,
        parentSubagentId,
        subtitle,
      })),
    ).toEqual([
      {
        title: "qa_paseo_progress",
        status: "completed",
        parentSubagentId: null,
        subtitle: "Verification · 2/2 completed · 1.9K tok · $0.0000",
      },
      {
        title: "QA alpha",
        status: "completed",
        parentSubagentId: id,
        subtitle: "Verification · CW/qwen3.8-27b:off · 953 tok",
      },
      {
        title: "QA beta",
        status: "completed",
        parentSubagentId: id,
        subtitle: "Verification · CW/qwen3.8-27b:off · 955 tok",
      },
    ]);
    const childTimeline = live.flatMap((event) => {
      if (
        event.type !== "provider_subagent" ||
        event.event.type !== "timeline" ||
        event.event.id !== `${id}:1`
      )
        return [];
      return [event.event.item];
    });
    expect(childTimeline).toEqual([
      {
        type: "user_message",
        text: "Reply exactly QA_ALPHA with no explanation. Do not call tools.",
      },
      { type: "assistant_message", text: "QA_ALPHA" },
    ]);
  });

  test("places a workflow and its children in the native Subagents tree", () => {
    const host = createPiExtensionHost();
    const output = host.mapCustomEntry(progress({ currentPhase: "Inspect" }));
    expect(output?.subagents).toEqual([
      {
        type: "upsert",
        id: "workflow:run-1",
        title: "Review",
        status: "running",
        cwd: "/project",
        parentSubagentId: null,
        subtitle: "Inspect · 0/1 completed · 1 running",
        timestamp: "2026-09-28T10:00:00.000Z",
      },
      {
        type: "upsert",
        id: "workflow:run-1:0",
        title: "Reviewer",
        description: "Review the patch",
        status: "running",
        cwd: "/project",
        parentSubagentId: "workflow:run-1",
        subtitle: null,
        timestamp: "2026-09-28T10:00:00.000Z",
      },
      {
        type: "timeline",
        id: "workflow:run-1:0",
        item: { type: "user_message", text: "Review the patch" },
        timestamp: "2026-09-28T10:00:00.000Z",
      },
    ]);
  });

  test("merges changed agent rows, retains duplicate labels, and deduplicates repeated progress", () => {
    const host = createPiExtensionHost();
    host.mapCustomEntry(
      progress({
        agentIds: [0, 1],
        agentCount: 2,
        runningCount: 2,
        agents: [
          { id: 0, label: "Reviewer", status: "running" },
          { id: 1, label: "Reviewer", status: "running" },
        ],
      }),
    );
    const update = progress({
      agentIds: [0, 1],
      agentCount: 2,
      doneCount: 1,
      agents: [
        {
          id: 1,
          label: "Reviewer",
          status: "done",
          model: "provider/model",
          tokens: 12345,
          estimatedTokens: true,
          resultPreview: "No issues",
        },
      ],
    });
    expect(host.mapCustomEntry(update)?.subagents).toEqual([
      expect.objectContaining({
        type: "upsert",
        id: "workflow:run-1",
        subtitle: "1/2 completed · 1 running",
      }),
      expect.objectContaining({
        type: "upsert",
        id: "workflow:run-1:1",
        status: "completed",
        subtitle: "provider/model · ~12.3K tok",
      }),
      {
        type: "timeline",
        id: "workflow:run-1:1",
        item: { type: "assistant_message", text: "No issues" },
        timestamp: update.timestamp,
      },
    ]);
    expect(
      host.mapCustomEntry({ ...update, id: "repeat", timestamp: "2026-09-28T10:01:00.000Z" })
        ?.subagents,
    ).toEqual([]);
    const paused = host.mapCustomEntry(
      progress({
        status: "paused",
        agentIds: [0, 1],
        agentCount: 2,
        doneCount: 1,
        runningCount: 0,
        agents: [],
      }),
    );
    expect(paused?.subagents).toEqual([
      expect.objectContaining({
        type: "upsert",
        id: "workflow:run-1",
        status: "canceled",
        subtitle: "Paused · 1/2 completed",
      }),
      expect.objectContaining({
        type: "upsert",
        id: "workflow:run-1:0",
        status: "canceled",
        subtitle: "Paused",
      }),
    ]);
  });

  test("restores queued work on resume and settles unfinished children on failure", () => {
    const host = createPiExtensionHost();
    host.mapCustomEntry(progress({ agents: [{ id: 0, label: "Reviewer", status: "queued" }] }));
    host.mapCustomEntry(progress({ status: "paused", agents: [] }));
    const resumed = host.mapCustomEntry(progress({ agents: [] }));
    expect(resumed?.subagents).toEqual([
      expect.objectContaining({ type: "upsert", id: "workflow:run-1", status: "running" }),
      expect.objectContaining({
        type: "upsert",
        id: "workflow:run-1:0",
        status: "running",
        subtitle: "Queued",
      }),
    ]);
    const failed = host.mapCustomEntry(
      progress({ status: "failed", runningCount: 0, error: "Budget exhausted", agents: [] }),
    );
    expect(failed?.subagents).toEqual([
      expect.objectContaining({ type: "upsert", id: "workflow:run-1", status: "failed" }),
      {
        type: "timeline",
        id: "workflow:run-1",
        item: { type: "error", message: "Budget exhausted" },
        timestamp: "2026-09-28T10:00:00.000Z",
      },
      expect.objectContaining({
        type: "upsert",
        id: "workflow:run-1:0",
        status: "canceled",
        subtitle: null,
      }),
    ]);
  });

  test("removes discarded rows and all descendants when a run is deleted", () => {
    const host = createPiExtensionHost();
    host.mapCustomEntry(
      progress({
        agentIds: [0, 1],
        agents: [
          { id: 0, label: "First", status: "done" },
          { id: 1, label: "Second", status: "running" },
        ],
      }),
    );
    expect(host.mapCustomEntry(progress({ agentIds: [1], agents: [] }))?.subagents).toEqual([
      { type: "remove", id: "workflow:run-1:0" },
    ]);
    const tombstone = { ...progress({}), data: { version: 1, runId: "run-1", deleted: true } };
    expect(host.mapCustomEntry(tombstone)?.subagents).toEqual([
      { type: "remove", id: "workflow:run-1:1" },
      { type: "remove", id: "workflow:run-1" },
    ]);
    expect(host.mapCustomEntry(tombstone)?.subagents).toEqual([]);
  });

  test("rejects foreign, malformed, and unsupported entries", () => {
    const host = createPiExtensionHost();
    expect(
      host.mapCustomEntry({ ...progress({}), customType: "another-extension" }),
    ).toBeUndefined();
    expect(host.mapCustomEntry(progress({ version: 2 }))).toBeUndefined();
    expect(
      host.mapCustomEntry(progress({ agents: [{ id: "bad", status: "running" }] })),
    ).toBeUndefined();
  });

  test("replays the same nested lifecycle and bounded result previews as live entries", async () => {
    const entries = [
      progress({}),
      progress({
        status: "completed",
        runningCount: 0,
        doneCount: 1,
        resultPreview: "Review complete",
        agents: [
          {
            id: 0,
            label: "Reviewer",
            status: "done",
            promptPreview: "Review the patch",
            resultPreview: "No issues",
            sessionFile: "/unused/session.jsonl",
          },
        ],
      }),
    ];
    const host = createPiExtensionHost();
    const live = entries.flatMap((entry) => host.mapCustomEntry(entry)?.events ?? []);
    const replay: AgentStreamEvent[] = [];
    for await (const event of streamPiHistory("pi", [], [], {}, undefined, undefined, entries))
      replay.push(event);
    expect(replay).toEqual(live);
    expect(
      replay.filter(
        (event) => event.type === "provider_subagent" && event.event.type === "timeline",
      ),
    ).toHaveLength(3);
  });
});
