import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import {
  ProviderSubagentStore,
  type ProviderSubagentDescriptor,
} from "../../../provider-subagents/store.js";
import { ClaudeTaskProtocolSource } from "./live-source.js";
import { foldSubagentObservations, type SubagentObservation } from "./observation.js";
import {
  observeReplaySubagents,
  parseClaudeSubagentMeta,
  type ClaudeReplayEntry,
  type ClaudeReplayParentFacts,
} from "./replay-source.js";

const TOOL_USE_ID = "toolu_01DgLoPMW9";
const AGENT_ID = "a1730a6215e1f5cf6";

function emptyParent(): ClaudeReplayParentFacts {
  return { toolCalls: new Map(), linksByAgentId: new Map(), outcomesByToolCallId: new Map() };
}

function parentWithTaskCall(failed = false): ClaudeReplayParentFacts {
  return {
    toolCalls: new Map([
      [
        TOOL_USE_ID,
        { title: "general-purpose", description: "Summarize hover and unistyles docs" },
      ],
    ]),
    linksByAgentId: new Map(),
    outcomesByToolCallId: new Map([[TOOL_USE_ID, { failed }]]),
  };
}

function applyToStore(observations: SubagentObservation[]): ProviderSubagentDescriptor | null {
  const store = new ProviderSubagentStore();
  let descriptor: ProviderSubagentDescriptor | null = null;
  for (const event of foldSubagentObservations(observations)) {
    const applied = store.apply("parent", "claude", event);
    if (applied.type === "upsert") descriptor = applied.subagent;
  }
  return descriptor;
}

describe("parseClaudeSubagentMeta", () => {
  it("reads the real sidecar shape", () => {
    expect(
      parseClaudeSubagentMeta(
        '{"agentType":"general-purpose","description":"Reply banana","toolUseId":"toolu_013i","spawnDepth":1}',
      ),
    ).toEqual({
      agentType: "general-purpose",
      description: "Reply banana",
      toolUseId: "toolu_013i",
      spawnDepth: 1,
    });
  });

  it.each([
    ["truncated json", '{"agentType":"Explore"'],
    ["not json at all", "agentType: Explore"],
    ["empty", ""],
    ["a json array", "[1,2,3]"],
    ["an object with no known fields", '{"unrelated":true}'],
  ])("treats %s as absent rather than throwing", (_label, contents) => {
    expect(parseClaudeSubagentMeta(contents)).toBeNull();
  });

  it("keeps the good fields when one field has the wrong type", () => {
    expect(parseClaudeSubagentMeta('{"agentType":"Explore","toolUseId":42}')).toEqual({
      agentType: "Explore",
      description: undefined,
      toolUseId: undefined,
      spawnDepth: undefined,
    });
  });
});

describe("observeReplaySubagents", () => {
  it("links a subagent to its Task call through meta.toolUseId", () => {
    const observations = observeReplaySubagents({
      subagents: [{ agentId: AGENT_ID, meta: { toolUseId: TOOL_USE_ID }, entries: [] }],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    });

    expect(observations[0]).toMatchObject({
      kind: "declared",
      id: TOOL_USE_ID,
      toolCallId: TOOL_USE_ID,
      title: "general-purpose",
      description: "Summarize hover and unistyles docs",
    });
  });

  it("replays only this session's own children, not their descendants", () => {
    // Claude Code writes every descendant into the same subagents/ directory. A grandchild's
    // toolUseId names a Task call made inside its parent's session, so nothing here can resolve
    // it: it would replay as an extra row the live stream never showed, with no Task card and no
    // outcome. One recorded session showed 10 subagents live and 22 on reopen.
    const observations = observeReplaySubagents({
      subagents: [
        { agentId: AGENT_ID, meta: { toolUseId: TOOL_USE_ID, spawnDepth: 1 }, entries: [] },
        {
          agentId: "a6acb4b898",
          meta: { toolUseId: "toolu_012rzYnFZA", agentType: "Explore", spawnDepth: 2 },
          entries: [],
        },
      ],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    });

    expect([...new Set(observations.map((observation) => observation.id))]).toEqual([TOOL_USE_ID]);
  });

  it("keeps a subagent recorded before spawnDepth existed", () => {
    const observations = observeReplaySubagents({
      subagents: [{ agentId: AGENT_ID, meta: { toolUseId: TOOL_USE_ID }, entries: [] }],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    });

    expect(observations[0]).toMatchObject({ kind: "declared", id: TOOL_USE_ID });
  });

  it("drops a meta-linked subagent when the parent never declared its Task", () => {
    const observations = observeReplaySubagents({
      subagents: [
        {
          agentId: AGENT_ID,
          meta: { toolUseId: TOOL_USE_ID, agentType: "Explore", description: "Find the code" },
          entries: [],
        },
      ],
      parent: emptyParent(),
      convertEntry: () => [],
    });

    expect(observations).toEqual([]);
  });

  it("falls back to the scraped link when there is no meta file", () => {
    const parent: ClaudeReplayParentFacts = {
      toolCalls: new Map([[TOOL_USE_ID, { title: "Explore" }]]),
      linksByAgentId: new Map([[AGENT_ID, { toolCallId: TOOL_USE_ID, failed: false }]]),
      outcomesByToolCallId: new Map(),
    };

    const [declared, ...rest] = observeReplaySubagents({
      subagents: [{ agentId: AGENT_ID, meta: null, entries: [] }],
      parent,
      convertEntry: () => [],
    });

    expect(declared).toMatchObject({ id: TOOL_USE_ID, toolCallId: TOOL_USE_ID, title: "Explore" });
    expect(rest.at(-1)).toMatchObject({ kind: "status", status: "completed" });
  });

  it("drops an unlinkable subagent", () => {
    const observations = observeReplaySubagents({
      subagents: [{ agentId: AGENT_ID, meta: null, entries: [] }],
      parent: emptyParent(),
      convertEntry: () => [],
    });
    expect(observations).toEqual([]);
  });

  it("drops a terminal subagent the parent has no Task call for", () => {
    // A legacy grandchild: its toolUseId names a Task call made inside a sibling's transcript, so
    // no tool_result for it can ever reach the parent. Left running, it never stops.
    const descriptor = applyToStore(
      observeReplaySubagents({
        subagents: [
          {
            agentId: AGENT_ID,
            meta: { toolUseId: TOOL_USE_ID },
            entries: [
              {
                type: "assistant",
                timestamp: "2026-07-31T03:41:00.000Z",
                message: { stop_reason: "end_turn" },
              },
            ],
          },
        ],
        parent: emptyParent(),
        convertEntry: () => [],
      }),
    );

    expect(descriptor).toBeNull();
  });

  it("drops a terminal skill-spawned subagent that has no link at all", () => {
    // A /code-review run: no Task tool_use exists to name it, so its sidecar carries only
    // agentType and its id appears nowhere in the parent transcript.
    const descriptor = applyToStore(
      observeReplaySubagents({
        subagents: [
          {
            agentId: AGENT_ID,
            meta: { agentType: "general-purpose" },
            entries: [
              {
                type: "assistant",
                timestamp: "2026-07-31T03:41:00.000Z",
                message: { stop_reason: "end_turn" },
              },
            ],
          },
        ],
        parent: emptyParent(),
        convertEntry: () => [],
      }),
    );

    expect(descriptor).toBeNull();
  });

  it("reports a scraped link's failure as failed", () => {
    const descriptor = applyToStore(
      observeReplaySubagents({
        subagents: [{ agentId: AGENT_ID, meta: null, entries: [] }],
        parent: {
          toolCalls: new Map([[TOOL_USE_ID, { title: "Explore" }]]),
          linksByAgentId: new Map([[AGENT_ID, { toolCallId: TOOL_USE_ID, failed: true }]]),
          outcomesByToolCallId: new Map(),
        },
        convertEntry: () => [],
      }),
    );

    expect(descriptor).toMatchObject({ id: TOOL_USE_ID, status: "failed" });
  });

  it("drops a non-terminal linkless subagent", () => {
    const observations = observeReplaySubagents({
      subagents: [
        {
          agentId: AGENT_ID,
          meta: { agentType: "general-purpose" },
          entries: [
            {
              type: "assistant",
              timestamp: "2026-07-31T03:41:00.000Z",
              message: { stop_reason: null },
            },
          ],
        },
      ],
      parent: emptyParent(),
      convertEntry: () => [],
    });

    expect(observations).toEqual([]);
  });

  it("finishes a terminal Task child when the parent has not recorded its outcome", () => {
    const descriptor = applyToStore(
      observeReplaySubagents({
        subagents: [
          {
            agentId: AGENT_ID,
            meta: { toolUseId: TOOL_USE_ID },
            entries: [
              {
                type: "assistant",
                timestamp: "2026-07-31T03:41:00.000Z",
                message: { stop_reason: "end_turn" },
              },
            ],
          },
        ],
        parent: { ...parentWithTaskCall(), outcomesByToolCallId: new Map() },
        convertEntry: () => [],
      }),
    );

    expect(descriptor).toMatchObject({ status: "completed" });
  });

  it("leaves a subagent with no recorded outcome running", () => {
    const observations = observeReplaySubagents({
      subagents: [{ agentId: AGENT_ID, meta: { toolUseId: TOOL_USE_ID }, entries: [] }],
      parent: { ...parentWithTaskCall(), outcomesByToolCallId: new Map() },
      convertEntry: () => [],
    });
    expect(observations.some((o) => o.kind === "status")).toBe(false);
  });

  it("reports a failed outcome as failed", () => {
    const observations = observeReplaySubagents({
      subagents: [{ agentId: AGENT_ID, meta: { toolUseId: TOOL_USE_ID }, entries: [] }],
      parent: parentWithTaskCall(true),
      convertEntry: () => [],
    });
    expect(observations.at(-1)).toMatchObject({ kind: "status", status: "failed" });
  });

  it("carries entry timestamps onto timeline observations", () => {
    const observations = observeReplaySubagents({
      subagents: [
        {
          agentId: AGENT_ID,
          meta: { toolUseId: TOOL_USE_ID },
          entries: [{ type: "assistant", timestamp: "2026-07-26T06:27:47.034Z" }],
        },
      ],
      parent: parentWithTaskCall(),
      convertEntry: () => [{ type: "reasoning", text: "thinking" }],
    });

    expect(observations.find((observation) => observation.kind === "timeline")).toMatchObject({
      kind: "timeline",
      id: TOOL_USE_ID,
      timestamp: "2026-07-26T06:27:47.034Z",
    });
  });
});

describe("replay runtime", () => {
  it("reads the model and effort off the subagent's own transcript", () => {
    const observations = observeReplaySubagents({
      subagents: [
        {
          agentId: AGENT_ID,
          meta: { toolUseId: TOOL_USE_ID },
          entries: [{ type: "assistant", effort: "high", message: { model: "claude-opus-5" } }],
        },
      ],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    });

    expect(observations.find((o) => o.kind === "subtitle")).toEqual({
      kind: "subtitle",
      id: TOOL_USE_ID,
      subtitle: "general-purpose · Opus 5 · High",
    });
  });

  it("takes the last observed values when the model changes mid-transcript", () => {
    const observations = observeReplaySubagents({
      subagents: [
        {
          agentId: AGENT_ID,
          meta: { toolUseId: TOOL_USE_ID },
          entries: [
            { type: "assistant", effort: "high", message: { model: "claude-opus-5" } },
            { type: "assistant", effort: "low", message: { model: "claude-sonnet-5" } },
          ],
        },
      ],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    });

    expect(observations.find((o) => o.kind === "subtitle")).toMatchObject({
      subtitle: "general-purpose · Sonnet 5 · Low",
    });
  });

  it("reports nothing when the transcript never names a model or effort", () => {
    const observations = observeReplaySubagents({
      subagents: [{ agentId: AGENT_ID, meta: { toolUseId: TOOL_USE_ID }, entries: [] }],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    });
    expect(observations.some((o) => o.kind === "subtitle")).toBe(false);
  });

  it("passes through a model the manifest does not know", () => {
    // Claude Code is an Anthropic-compatible client; subagents legitimately report other models.
    const observations = observeReplaySubagents({
      subagents: [
        {
          agentId: AGENT_ID,
          meta: { toolUseId: TOOL_USE_ID },
          entries: [{ type: "assistant", message: { model: "glm-5.1" } }],
        },
      ],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    });
    expect(observations.find((o) => o.kind === "subtitle")).toMatchObject({
      subtitle: "general-purpose · glm-5.1",
    });
  });
});

describe("replay usage", () => {
  function subtitleOf(entries: ClaudeReplayEntry[]): SubagentObservation | undefined {
    return observeReplaySubagents({
      subagents: [{ agentId: AGENT_ID, meta: { toolUseId: TOOL_USE_ID }, entries }],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    }).find((observation) => observation.kind === "subtitle");
  }

  it("derives the counters Claude Code itself reports, from a real transcript's shape", () => {
    // Shape and numbers taken from an on-disk subagent transcript. Claude Code finalizes a
    // subagent from the LAST assistant entry's usage, so the earlier, smaller turn must not win
    // and must not be added in.
    expect(
      subtitleOf([
        {
          type: "assistant",
          timestamp: "2026-07-23T23:18:43.023Z",
          message: {
            model: "claude-opus-5",
            content: [
              { type: "tool_use", name: "Read" },
              { type: "text", text: "hi" },
            ],
            usage: {
              input_tokens: 4,
              cache_creation_input_tokens: 15_000,
              cache_read_input_tokens: 0,
              output_tokens: 120,
            },
          },
        },
        { type: "user", timestamp: "2026-07-23T23:20:00.000Z", message: { content: [] } },
        {
          type: "assistant",
          timestamp: "2026-07-23T23:49:05.068Z",
          message: {
            model: "claude-opus-5",
            content: [{ type: "tool_use", name: "Grep" }],
            usage: {
              input_tokens: 2293,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 65_024,
              output_tokens: 1376,
            },
          },
        },
      ]),
    ).toEqual({
      kind: "subtitle",
      id: TOOL_USE_ID,
      // 2293 + 0 + 65024 + 1376 — the last turn's context, matching the live path's total_tokens.
      subtitle: "general-purpose · Opus 5 · 68.7k tokens",
      timestamp: "2026-07-23T23:49:05.068Z",
    });
  });

  it("formats tokens for a child that only answered", () => {
    expect(
      subtitleOf([
        {
          type: "assistant",
          timestamp: "2026-07-27T16:42:14.698Z",
          message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 16_434 } },
        },
        {
          type: "user",
          timestamp: "2026-07-27T16:42:16.926Z",
          message: { content: "ignored" },
        },
      ]),
    ).toMatchObject({ subtitle: "general-purpose · 16.4k tokens" });
  });

  it("emits nothing for a transcript with no entries", () => {
    expect(subtitleOf([])).toBeUndefined();
  });

  it("keeps duration out of the compact subtitle", () => {
    const observation = subtitleOf([
      {
        type: "assistant",
        timestamp: "2026-07-27T16:42:14.698Z",
        message: { content: [], usage: { input_tokens: 10 } },
      },
    ]);
    expect(observation).toMatchObject({ subtitle: "general-purpose · 10 tokens" });
  });

  it("omits totalTokens when no entry carries a usage block", () => {
    const observation = subtitleOf([
      { type: "assistant", timestamp: "2026-07-27T16:42:14.698Z", message: { content: [] } },
      {
        type: "assistant",
        timestamp: "2026-07-27T16:42:20.000Z",
        message: { content: [{ type: "tool_use", name: "Bash" }], usage: "not-an-object" },
      },
    ]);
    expect(observation).toBeUndefined();
  });

  it("keeps the last usage-bearing entry when the final assistant entry has none", () => {
    expect(
      subtitleOf([
        {
          type: "assistant",
          timestamp: "2026-07-27T16:42:14.698Z",
          message: { content: [], usage: { input_tokens: 900, output_tokens: 100 } },
        },
        { type: "assistant", timestamp: "2026-07-27T16:42:20.000Z", message: { content: [] } },
      ]),
    ).toMatchObject({ subtitle: "general-purpose · 1k tokens" });
  });

  it("only reports counters the transcript actually shows", () => {
    // A user-only transcript says nothing about cost: no assistant turn, so no tool count either.
    const observation = subtitleOf([
      { type: "user", timestamp: "2026-07-27T16:42:14.698Z", message: { content: "prompt" } },
      { type: "user", timestamp: "2026-07-27T16:42:20.000Z", message: { content: "more" } },
    ]);
    expect(observation).toBeUndefined();
  });

  it("lands the complete provider-owned subtitle on the descriptor", () => {
    const store = new ProviderSubagentStore();
    const observations = observeReplaySubagents({
      subagents: [
        {
          agentId: AGENT_ID,
          meta: { toolUseId: TOOL_USE_ID },
          entries: [
            {
              type: "assistant",
              timestamp: "2026-07-27T16:42:14.698Z",
              message: { content: [], usage: { input_tokens: 7 } },
            },
          ],
        },
      ],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    });
    for (const event of foldSubagentObservations(observations)) {
      store.apply("parent", "claude", event);
    }

    expect(store.get("parent", TOOL_USE_ID)?.subtitle).toBe("general-purpose · 7 tokens");
  });
});

describe("live and replay agree", () => {
  // The property the design exists to guarantee: one session, two sources, one descriptor.
  // This is inexpressible against the inference implementation, where the paths share no
  // vocabulary and each derives identity and status its own way.
  it("produces identical descriptor state from the wire and from disk", () => {
    const live = new ClaudeTaskProtocolSource();
    const liveObservations = [
      ...live.observe({
        type: "system",
        subtype: "task_started",
        task_id: AGENT_ID,
        tool_use_id: TOOL_USE_ID,
        description: "Summarize hover and unistyles docs",
        subagent_type: "general-purpose",
        task_type: "local_agent",
      } as unknown as SDKMessage),
      ...live.observe({
        type: "system",
        subtype: "task_updated",
        task_id: AGENT_ID,
        patch: { status: "completed" },
      } as unknown as SDKMessage),
    ];

    const replayObservations = observeReplaySubagents({
      subagents: [
        {
          agentId: AGENT_ID,
          meta: {
            toolUseId: TOOL_USE_ID,
            agentType: "general-purpose",
            description: "Summarize hover and unistyles docs",
          },
          entries: [],
        },
      ],
      parent: parentWithTaskCall(),
      convertEntry: () => [],
    });

    const fromWire = applyToStore(liveObservations);
    const fromDisk = applyToStore(replayObservations);

    const identity = (descriptor: ProviderSubagentDescriptor | null) => ({
      id: descriptor?.id,
      title: descriptor?.title,
      description: descriptor?.description,
      status: descriptor?.status,
      toolCallId: descriptor?.toolCallId,
    });

    expect(identity(fromWire)).toEqual(identity(fromDisk));
    expect(identity(fromWire)).toEqual({
      id: TOOL_USE_ID,
      title: "general-purpose",
      description: "Summarize hover and unistyles docs",
      status: "completed",
      toolCallId: TOOL_USE_ID,
    });
  });
});
