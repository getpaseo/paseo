import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  buildAgentStreamSearchModel,
  findAgentStreamSearchMatches,
} from "./agent-stream-search-model";

function timestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, text: string, seed = 1): StreamItem {
  return {
    kind: "user_message",
    id,
    text,
    timestamp: timestamp(seed),
  };
}

function assistantMessage(id: string, text: string, seed = 1): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: timestamp(seed),
  };
}

function thought(id: string, text: string, seed = 1): StreamItem {
  return {
    kind: "thought",
    id,
    text,
    status: "ready",
    timestamp: timestamp(seed),
  };
}

function activityLog(id: string, message: string, seed = 1): StreamItem {
  return {
    kind: "activity_log",
    id,
    activityType: "info",
    message,
    metadata: { hidden: "metadata is not searched" },
    timestamp: timestamp(seed),
  };
}

function todoList(id: string, seed = 1): StreamItem {
  return {
    kind: "todo_list",
    id,
    provider: "codex",
    items: [
      { text: "Write the red test", completed: true },
      { text: "Make search green", completed: false },
    ],
    timestamp: timestamp(seed),
  };
}

function getSearchableText(item: StreamItem): string {
  const model = buildAgentStreamSearchModel({
    streamItems: [item],
    streamHead: [],
    platform: "web",
    isMobileBreakpoint: true,
  });
  return model.entries[0]?.text ?? "";
}

describe("buildAgentStreamSearchModel", () => {
  it("indexes user and assistant message text", () => {
    expect(getSearchableText(userMessage("u1", "user text"))).toBe("user text");
    expect(getSearchableText(assistantMessage("a1", "assistant text"))).toBe("assistant text");
  });

  it("excludes non-message rows that do not render find highlights", () => {
    expect(getSearchableText(thought("t1", "thought text"))).toBe("");
    expect(getSearchableText(activityLog("l1", "activity text"))).toBe("");
    expect(getSearchableText(todoList("todo"))).toBe("");
  });

  it("excludes tool call rows from the search index", () => {
    const toolCall: StreamItem = {
      kind: "tool_call",
      id: "shell",
      timestamp: timestamp(1),
      payload: {
        source: "agent",
        data: {
          provider: "codex",
          callId: "call-shell",
          name: "exec_command",
          status: "completed",
          error: null,
          detail: {
            type: "shell",
            command: "npm run typecheck",
            output: "internal output should stay out",
          },
        },
      },
    };

    expect(getSearchableText(toolCall)).toBe("");
  });

  it("orders virtualized history, mounted history, live head, and optimistic items deterministically", () => {
    const committed: StreamItem[] = [];
    for (let index = 0; index < 64; index += 1) {
      committed.push(userMessage(`u${index}`, `history ${index}`, index));
    }
    const optimistic = userMessage("optimistic", "draft message", 65);
    const liveHead = [assistantMessage("live", "live answer", 66)];

    const model = buildAgentStreamSearchModel({
      streamItems: committed,
      optimisticItems: [optimistic],
      streamHead: liveHead,
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.entries.at(0)?.item.id).toBe("optimistic");
    expect(model.entries.map((entry) => entry.source)).toEqual([
      ...Array.from(
        { length: model.segments.historyVirtualized.length },
        () => "historyVirtualized",
      ),
      ...Array.from({ length: model.segments.historyMounted.length }, () => "historyMounted"),
      "liveHead",
    ]);
    expect(model.entries.at(-1)?.item.id).toBe("live");
  });

  it("does not duplicate an optimistic item once committed history has the same id", () => {
    const committed = [userMessage("u1", "committed draft")];
    const model = buildAgentStreamSearchModel({
      streamItems: committed,
      optimisticItems: [userMessage("u1", "optimistic draft")],
      streamHead: [],
      platform: "web",
      isMobileBreakpoint: true,
    });

    expect(model.entries.map((entry) => entry.text)).toEqual(["committed draft"]);
  });
});

describe("findAgentStreamSearchMatches", () => {
  it("returns stable match ids from item identity and local occurrence data", () => {
    const model = buildAgentStreamSearchModel({
      streamItems: [assistantMessage("a1", "Alpha alpha beta")],
      streamHead: [assistantMessage("h1", "alpha live")],
      platform: "web",
      isMobileBreakpoint: true,
    });

    const matches = findAgentStreamSearchMatches({
      model,
      query: "alpha",
    });

    expect(matches.map((match) => match.id)).toEqual([
      "a1:text:0:0:5",
      "a1:text:1:6:11",
      "h1:text:0:0:5",
    ]);
    expect(matches.map((match) => match.entry.item.id)).toEqual(["a1", "a1", "h1"]);
  });

  it("skips fenced code blocks while preserving message offsets for highlights", () => {
    const model = buildAgentStreamSearchModel({
      streamItems: [assistantMessage("a1", "before alpha\n```\nalpha\n```\nafter alpha")],
      streamHead: [],
      platform: "web",
      isMobileBreakpoint: true,
    });

    const matches = findAgentStreamSearchMatches({
      model,
      query: "alpha",
    });

    expect(matches.map((match) => match.id)).toEqual(["a1:text:0:7:12", "a1:text:0:33:38"]);
  });
});
