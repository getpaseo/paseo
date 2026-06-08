import { describe, expect, it } from "vitest";

import { translateOpenCodeEvent, type OpenCodeEventTranslationState } from "../opencode-agent.js";

const openCodePermissionActions = [
  {
    id: "deny",
    label: "Deny",
    behavior: "deny",
    variant: "danger",
    intent: "dismiss",
  },
  {
    id: "allow_always",
    label: "Allow always",
    behavior: "allow",
    variant: "secondary",
  },
  {
    id: "allow_once",
    label: "Allow once",
    behavior: "allow",
    variant: "primary",
  },
];

function createState(sessionId = "session-1"): OpenCodeEventTranslationState {
  return {
    sessionId,
    messageRoles: new Map(),
    accumulatedUsage: {},
    streamedPartKeys: new Set(),
    emittedStructuredMessageIds: new Set(),
    compactionSummaryMessageIds: new Set(),
    emittedCompactionPartIds: new Set(),
    partTypes: new Map(),
  };
}

describe("translateOpenCodeEvent", () => {
  it("resolves context window max tokens from assistant message.updated model metadata", () => {
    const resolvedContextWindowMaxTokens: number[] = [];
    const state = createState();
    state.modelContextWindowsByModelKey = new Map([["anthropic/claude-sonnet-4", 200_000]]);
    state.onAssistantModelContextWindowResolved = (contextWindowMaxTokens) => {
      resolvedContextWindowMaxTokens.push(contextWindowMaxTokens);
    };

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-model-1",
            sessionID: "session-1",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet-4",
          },
        },
      },
      state,
    );

    expect(resolvedContextWindowMaxTokens).toEqual([200_000]);
  });

  it("does not duplicate assistant output when completed part echoes streamed delta", () => {
    const state = createState();

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "session-1",
            role: "assistant",
          },
        },
      },
      state,
    );

    const streamed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          delta: "hey! what can I help with?",
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "text",
            time: { start: 1 },
          },
        },
      },
      state,
    );

    const completed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "text",
            text: "hey! what can I help with?",
            time: { start: 1, end: 2 },
          },
        },
      },
      state,
    );

    const assistantEvents = [...streamed, ...completed].filter(
      (event) => event.type === "timeline" && event.item.type === "assistant_message",
    );

    expect(assistantEvents).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "hey! what can I help with?" },
      },
    ]);
  });

  it("emits completed assistant text when no delta was streamed", () => {
    const state = createState();

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-2",
            sessionID: "session-1",
            role: "assistant",
          },
        },
      },
      state,
    );

    const completed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-2",
            sessionID: "session-1",
            messageID: "message-2",
            type: "text",
            text: "final text",
            time: { start: 3, end: 4 },
          },
        },
      },
      state,
    );

    expect(completed).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "final text" },
      },
    ]);
  });

  it("does not duplicate reasoning output when completed part echoes streamed delta", () => {
    const state = createState();

    const streamed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          delta: "The user said hello.",
          part: {
            id: "reasoning-part-1",
            sessionID: "session-1",
            messageID: "message-3",
            type: "reasoning",
            time: { start: 10 },
          },
        },
      },
      state,
    );

    const completed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "reasoning-part-1",
            sessionID: "session-1",
            messageID: "message-3",
            type: "reasoning",
            text: "The user said hello.",
            time: { start: 10, end: 11 },
          },
        },
      },
      state,
    );

    const reasoningEvents = [...streamed, ...completed].filter(
      (event) => event.type === "timeline" && event.item.type === "reasoning",
    );

    expect(reasoningEvents).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "reasoning", text: "The user said hello." },
      },
    ]);
  });

  it("emits assistant text from message.part.delta events", () => {
    const state = createState();

    // Register message role
    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: { id: "msg-d1", sessionID: "session-1", role: "assistant" },
        },
      },
      state,
    );

    // OpenCode v2 can send streaming text as message.part.delta
    const delta1 = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-d1",
          partID: "part-d1",
          field: "text",
          delta: "hey! ",
        },
      },
      state,
    );

    const delta2 = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-d1",
          partID: "part-d1",
          field: "text",
          delta: "what's up?",
        },
      },
      state,
    );

    expect([...delta1, ...delta2]).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "hey! " },
      },
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "what's up?" },
      },
    ]);
  });

  it("humanizes permission requests and includes shell detail when command metadata exists", () => {
    const state = createState();

    const result = translateOpenCodeEvent(
      {
        type: "permission.asked",
        properties: {
          id: "perm-1",
          sessionID: "session-1",
          permission: "external_directory",
          patterns: ["/home/user/secrets/*"],
          metadata: {
            command: "ls /home/user/secrets",
            reason: "Need to inspect generated files",
          },
          tool: {
            messageID: "message-1",
            callID: "call-1",
          },
        },
      },
      state,
    );

    expect(result).toEqual([
      {
        type: "permission_requested",
        provider: "opencode",
        request: {
          id: "perm-1",
          provider: "opencode",
          name: "external_directory",
          kind: "tool",
          title: "Access external directory",
          description: "Need to inspect generated files - Scope: /home/user/secrets/*",
          input: {
            patterns: ["/home/user/secrets/*"],
            metadata: {
              command: "ls /home/user/secrets",
              reason: "Need to inspect generated files",
            },
            tool: {
              messageID: "message-1",
              callID: "call-1",
            },
            command: "ls /home/user/secrets",
          },
          detail: {
            type: "shell",
            command: "ls /home/user/secrets",
          },
          actions: openCodePermissionActions,
        },
      },
    ]);
  });

  it("falls back to unknown permission detail when command metadata is absent", () => {
    const state = createState();

    const result = translateOpenCodeEvent(
      {
        type: "permission.asked",
        properties: {
          id: "perm-2",
          sessionID: "session-1",
          permission: "external_directory",
          patterns: ["/tmp/outside/*"],
          metadata: {
            reason: "Need to access temporary checkout",
          },
        },
      },
      state,
    );

    expect(result).toEqual([
      {
        type: "permission_requested",
        provider: "opencode",
        request: {
          id: "perm-2",
          provider: "opencode",
          name: "external_directory",
          kind: "tool",
          title: "Access external directory",
          description: "Need to access temporary checkout - Scope: /tmp/outside/*",
          input: {
            patterns: ["/tmp/outside/*"],
            metadata: {
              reason: "Need to access temporary checkout",
            },
          },
          detail: {
            type: "unknown",
            input: {
              permission: "external_directory",
              patterns: ["/tmp/outside/*"],
              metadata: {
                reason: "Need to access temporary checkout",
              },
            },
            output: null,
          },
          actions: openCodePermissionActions,
        },
      },
    ]);
  });

  it("forwards permission requests from linked OpenCode subagent sessions", () => {
    const state = createState();

    translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-subagent",
            sessionID: "session-1",
            messageID: "message-1",
            type: "tool",
            tool: "task",
            callID: "call-subagent",
            state: {
              status: "running",
              input: {
                subagent_type: "explore",
                description: "Explore external config",
              },
            },
          },
        },
      },
      state,
    );
    translateOpenCodeEvent(
      {
        type: "session.created",
        properties: {
          sessionID: "child-session-1",
          info: {
            id: "child-session-1",
            parentID: "session-1",
          },
        },
      },
      state,
    );

    const result = translateOpenCodeEvent(
      {
        type: "permission.asked",
        properties: {
          id: "perm-child-1",
          sessionID: "child-session-1",
          permission: "external_directory",
          patterns: ["/Users/example/.config/nvim"],
          metadata: {
            reason: "Need to inspect the requested config directory",
          },
        },
      },
      state,
    );

    expect(result).toEqual([
      {
        type: "permission_requested",
        provider: "opencode",
        request: {
          id: "perm-child-1",
          provider: "opencode",
          name: "external_directory",
          kind: "tool",
          title: "Access external directory",
          description:
            "Need to inspect the requested config directory - Scope: /Users/example/.config/nvim",
          input: {
            patterns: ["/Users/example/.config/nvim"],
            metadata: {
              reason: "Need to inspect the requested config directory",
            },
          },
          detail: {
            type: "unknown",
            input: {
              permission: "external_directory",
              patterns: ["/Users/example/.config/nvim"],
              metadata: {
                reason: "Need to inspect the requested config directory",
              },
            },
            output: null,
          },
          actions: openCodePermissionActions,
        },
      },
    ]);
  });

  it("emits usage_updated after step-finish parts", () => {
    const state = createState();
    state.accumulatedUsage.contextWindowMaxTokens = 400_000;

    const events = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "step-finish-1",
            sessionID: "session-1",
            messageID: "message-usage-1",
            type: "step-finish",
            reason: "stop",
            cost: 0.25,
            tokens: {
              total: 999_999,
              input: 30_000,
              output: 12_000,
              reasoning: 10_000,
              cache: {
                read: 2_000,
                write: 1_000,
              },
            },
          },
        },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: "usage_updated",
        provider: "opencode",
        usage: {
          contextWindowMaxTokens: 400_000,
          contextWindowUsedTokens: 55_000,
          cachedInputTokens: 2_000,
          inputTokens: 30_000,
          outputTokens: 12_000,
          totalCostUsd: 0.25,
        },
      },
    ]);
    expect(state.accumulatedUsage).toEqual({
      contextWindowMaxTokens: 400_000,
      contextWindowUsedTokens: 55_000,
      cachedInputTokens: 2_000,
      inputTokens: 30_000,
      outputTokens: 12_000,
      totalCostUsd: 0.25,
    });
  });

  it("reports totalCostUsd as cumulative session cost across turns", () => {
    const state = createState();
    state.accumulatedUsage.contextWindowMaxTokens = 400_000;
    state.sessionTotalCostUsd = 0.5;

    const events = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "step-finish-1",
            sessionID: "session-1",
            messageID: "message-usage-1",
            type: "step-finish",
            reason: "stop",
            cost: 0.25,
            tokens: {
              total: 55_000,
              input: 30_000,
              output: 12_000,
              reasoning: 10_000,
              cache: {
                read: 2_000,
                write: 1_000,
              },
            },
          },
        },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: "usage_updated",
        provider: "opencode",
        usage: expect.objectContaining({
          totalCostUsd: 0.75,
        }),
      },
    ]);
    expect(state.sessionTotalCostUsd).toBe(0.75);
    expect(state.accumulatedUsage.totalCostUsd).toBe(0.75);
  });

  it("seeds cumulative session cost from OpenCode session updates", () => {
    const state = createState();

    translateOpenCodeEvent(
      {
        type: "session.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "session-1",
            cost: 1.25,
          },
        },
      } as Parameters<typeof translateOpenCodeEvent>[0],
      state,
    );

    expect(state.sessionTotalCostUsd).toBe(1.25);
    expect(state.accumulatedUsage.totalCostUsd).toBe(1.25);
  });

  it("emits normalized todo timeline items from todo.updated", () => {
    const state = createState();

    const events = translateOpenCodeEvent(
      {
        type: "todo.updated",
        properties: {
          sessionID: "session-1",
          todos: [
            { content: "Outline", status: "pending", priority: "high" },
            { content: "Ship", status: "completed", priority: "medium" },
            { content: "   ", status: "completed", priority: "low" },
          ],
        },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "todo",
          items: [
            { text: "Outline", completed: false },
            { text: "Ship", completed: true },
          ],
        },
      },
    ]);
  });

  it("suppresses live todowrite tool parts because OpenCode emits todo.updated separately", () => {
    const state = createState();

    const events = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-todowrite",
            sessionID: "session-1",
            messageID: "message-1",
            type: "tool",
            tool: "todowrite",
            callID: "call-todowrite",
            state: {
              status: "running",
              input: {},
            },
          },
        },
      },
      state,
    );

    expect(events).toEqual([]);
  });

  it("maps live OpenCode tool parts through canonical detail branches", () => {
    const state = createState();

    const patchText = [
      "*** Begin Patch",
      "*** Delete File: /tmp/repo/src/App.tsx",
      "*** End Patch",
    ].join("\n");

    const events = [
      {
        id: "part-grep",
        tool: "grep",
        callID: "call-grep",
        state: { status: "completed", input: { pattern: "sendCorrelatedSessionRequest" } },
      },
      {
        id: "part-skill",
        tool: "skill",
        callID: "call-skill",
        state: {
          status: "completed",
          input: { name: "diagnose" },
          output: '<skill_content name="diagnose"># Skill: diagnose</skill_content>',
        },
      },
      {
        id: "part-apply-patch",
        tool: "apply_patch",
        callID: "call-apply-patch",
        state: {
          status: "completed",
          input: { patchText },
          output: "Success. Updated the following files:\nD /tmp/repo/src/App.tsx",
        },
      },
    ].flatMap((part) =>
      translateOpenCodeEvent(
        {
          type: "message.part.updated",
          properties: {
            part: {
              ...part,
              sessionID: "session-1",
              messageID: "message-1",
              type: "tool",
            },
          },
        },
        state,
      ),
    );

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "tool_call",
          callId: "call-grep",
          name: "grep",
          status: "completed",
          detail: {
            type: "search",
            query: "sendCorrelatedSessionRequest",
            toolName: "grep",
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "tool_call",
          callId: "call-skill",
          name: "skill",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "diagnose",
            icon: "sparkles",
            text: '<skill_content name="diagnose"># Skill: diagnose</skill_content>',
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "tool_call",
          callId: "call-apply-patch",
          name: "apply_patch",
          status: "completed",
          detail: {
            type: "edit",
            filePath: "/tmp/repo/src/App.tsx",
            unifiedDiff: [
              "diff --git a//tmp/repo/src/App.tsx b//tmp/repo/src/App.tsx",
              "--- a//tmp/repo/src/App.tsx",
              "+++ /dev/null",
            ].join("\n"),
          },
          error: null,
        },
      },
    ]);
  });

  it("emits compaction loading timeline items from compaction parts", () => {
    const state = createState();

    const events = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "compaction-part-1",
            sessionID: "session-1",
            messageID: "message-compaction-1",
            type: "compaction",
            auto: true,
          },
        },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "compaction",
          status: "loading",
          trigger: "auto",
        },
      },
    ]);
  });

  it("does not render OpenCode compaction summaries as assistant messages", () => {
    const state = createState();

    const loading = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "compaction-part-1",
            sessionID: "session-1",
            messageID: "message-compaction-user-1",
            type: "compaction",
            auto: true,
          },
        },
      },
      state,
    );

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-compaction-summary-1",
            sessionID: "session-1",
            role: "assistant",
            mode: "compaction",
            agent: "compaction",
            summary: true,
          },
        },
      },
      state,
    );

    const summaryText = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "summary-text-part-1",
            sessionID: "session-1",
            messageID: "message-compaction-summary-1",
            type: "text",
            text: "## Goal\n- Preserve context while continuing the task.",
            time: { start: 1, end: 2 },
          },
        },
      },
      state,
    );

    const duplicateLoading = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "compaction-part-1",
            sessionID: "session-1",
            messageID: "message-compaction-user-1",
            type: "compaction",
            auto: true,
            tail_start_id: "message-tail-1",
          },
        },
      },
      state,
    );

    const completed = translateOpenCodeEvent(
      {
        type: "session.compacted",
        properties: {
          sessionID: "session-1",
        },
      },
      state,
    );

    expect([...loading, ...summaryText, ...duplicateLoading, ...completed]).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "compaction",
          status: "loading",
          trigger: "auto",
        },
      },
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "compaction",
          status: "completed",
        },
      },
    ]);
  });

  it("emits compaction completed timeline items from session.compacted", () => {
    const state = createState();

    const events = translateOpenCodeEvent(
      {
        type: "session.compacted",
        properties: {
          sessionID: "session-1",
        },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "compaction",
          status: "completed",
        },
      },
    ]);
  });

  it("emits reasoning from message.part.delta events", () => {
    const state = createState();

    const delta = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-r1",
          partID: "rp-1",
          field: "reasoning",
          delta: "The user said hello.",
        },
      },
      state,
    );

    expect(delta).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "reasoning", text: "The user said hello." },
      },
    ]);
  });

  it("emits reasoning (not assistant_message) when delta field is 'text' for a known reasoning part", () => {
    const state = createState();

    // Part created as reasoning (message.part.updated fires before deltas)
    translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "rp-2",
            sessionID: "session-1",
            messageID: "msg-r2",
            type: "reasoning",
            time: { start: 1 },
          },
        },
      },
      state,
    );

    // Deltas arrive with field="text" (the field name on ReasoningPart)
    const delta1 = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-r2",
          partID: "rp-2",
          field: "text",
          delta: "Thinking about this...",
        },
      },
      state,
    );

    // Completed reasoning part should be deduped
    const completed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "rp-2",
            sessionID: "session-1",
            messageID: "msg-r2",
            type: "reasoning",
            text: "Thinking about this...",
            time: { start: 1, end: 2 },
          },
        },
      },
      state,
    );

    const allEvents = [...delta1, ...completed];

    expect(allEvents).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "reasoning", text: "Thinking about this..." },
      },
    ]);
  });

  it("deduplicates when message.part.delta is followed by completed message.part.updated", () => {
    const state = createState();

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: { id: "msg-dd1", sessionID: "session-1", role: "assistant" },
        },
      },
      state,
    );

    // Stream via delta event
    const streamed = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-dd1",
          partID: "part-dd1",
          field: "text",
          delta: "hello there",
        },
      },
      state,
    );

    // Completed part echoes the same text
    const completed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-dd1",
            sessionID: "session-1",
            messageID: "msg-dd1",
            type: "text",
            text: "hello there",
            time: { start: 1, end: 2 },
          },
        },
      },
      state,
    );

    const all = [...streamed, ...completed].filter(
      (e) => e.type === "timeline" && e.item.type === "assistant_message",
    );
    // Only the delta, not the completed echo
    expect(all).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "hello there" },
      },
    ]);
  });

  it("ignores message.part.delta for wrong session", () => {
    const state = createState();

    const result = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "other-session",
          messageID: "msg-1",
          partID: "part-1",
          field: "text",
          delta: "should not appear",
        },
      },
      state,
    );

    expect(result).toEqual([]);
  });

  it("ignores message.part.delta for user messages", () => {
    const state = createState();

    // Register as user message
    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: { id: "msg-u1", sessionID: "session-1", role: "user" },
        },
      },
      state,
    );

    const result = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-u1",
          partID: "part-u1",
          field: "text",
          delta: "user typing",
        },
      },
      state,
    );

    expect(result).toEqual([]);
  });

  it("emits turn_completed from session.status idle", () => {
    const state = createState();
    state.streamedPartKeys.add("text:part-1");
    state.partTypes.set("part-1", "text");

    const result = translateOpenCodeEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: { type: "idle" },
        },
      },
      state,
    );

    expect(result).toEqual([
      {
        type: "turn_completed",
        provider: "opencode",
        usage: undefined,
      },
    ]);
    expect(state.streamedPartKeys.size).toBe(0);
    expect(state.partTypes.size).toBe(0);
  });

  it("forwards session.status retry as a non-terminal timeline error item", () => {
    const state = createState();
    state.streamedPartKeys.add("text:part-1");
    state.partTypes.set("part-1", "text");

    const result = translateOpenCodeEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: {
            type: "retry",
            attempt: 3,
            message: "Internal server error",
            next: Date.now() + 1000,
          },
        },
      },
      state,
    );

    expect(result).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "error", message: "Provider retry (attempt 3): Internal server error" },
      },
    ]);
    // Streaming state must NOT be reset — the turn is still alive, opencode
    // will eventually either succeed or emit session.idle / session.error.
    expect(state.streamedPartKeys.size).toBe(1);
    expect(state.partTypes.size).toBe(1);
  });

  it("forwards retry without a message using just the attempt number", () => {
    const state = createState();

    const result = translateOpenCodeEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: {
            type: "retry",
            attempt: 1,
            message: "",
            next: Date.now() + 1000,
          },
        },
      },
      state,
    );

    expect(result).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "error", message: "Provider retry (attempt 1)" },
      },
    ]);
  });

  it("ignores transient session.status busy updates", () => {
    const state = createState();

    const busy = translateOpenCodeEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: { type: "busy" },
        },
      },
      state,
    );

    expect(busy).toEqual([]);
  });

  it("emits structured assistant output when schema mode completes without text parts", () => {
    const state = createState();

    const first = translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-structured-1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            structured: { summary: "hello" },
          },
        },
      },
      state,
    );

    const second = translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-structured-1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            structured: { summary: "hello" },
          },
        },
      },
      state,
    );

    expect(first).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: '{"summary":"hello"}' },
      },
    ]);
    expect(second).toEqual([]);
  });

  it("translates session.error with MessageAbortedError as turn_canceled, not turn_failed", () => {
    const state = createState();

    const events = translateOpenCodeEvent(
      {
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: {
            name: "MessageAbortedError",
            data: { message: "aborted" },
          },
        },
      },
      state,
    );

    expect(events).toEqual([
      { type: "turn_canceled", provider: "opencode", reason: "interrupted" },
    ]);
  });

  it("translates session.error with a real error as turn_failed", () => {
    const state = createState();

    const events = translateOpenCodeEvent(
      {
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: {
            name: "UnknownError",
            data: { message: "something broke" },
          },
        },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: "turn_failed",
        provider: "opencode",
        error: '{"name":"UnknownError","data":{"message":"something broke"}}',
      },
    ]);
  });
});
