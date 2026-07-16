import { describe, it, expect, beforeEach } from "vitest";
import type { StreamItem } from "@/types/stream";
import { searchItems, extractSearchText, createTimelineSearchModel } from "./timeline-search-model";

// ---- Fixtures ----

function isNotId(id: string) {
  return (item: StreamItem) => item.id !== id;
}

function makeUserMessage(text: string, id = "um1"): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date("2024-01-01") };
}

function makeAssistantMessage(text: string, id = "am1"): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: new Date("2024-01-01") };
}

function makeThought(text: string, id = "t1"): StreamItem {
  return { kind: "thought", id, text, timestamp: new Date("2024-01-01"), status: "ready" };
}

function makeTodo(items: string[], id = "todo1"): StreamItem {
  return {
    kind: "todo_list",
    id,
    timestamp: new Date("2024-01-01"),
    provider: "claude",
    items: items.map((text) => ({ text, completed: false })),
  };
}

function makeActivityLog(
  message: string,
  activityType: "error" | "info" | "system" | "success",
  id = "log1",
): StreamItem {
  return { kind: "activity_log", id, timestamp: new Date("2024-01-01"), activityType, message };
}

type AgentToolStatus = "running" | "completed" | "failed" | "canceled";

function makeShellToolCall(
  name: string,
  command: string,
  output: string | undefined,
  status: AgentToolStatus,
  id = "tc1",
): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date("2024-01-01"),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name,
        status,
        error: status === "failed" ? "Command failed with exit 1" : null,
        detail: {
          type: "shell",
          command,
          ...(output !== undefined ? { output } : {}),
        },
        metadata: undefined,
      },
    },
  };
}

function makeReadToolCall(
  filePath: string,
  content: string | undefined,
  status: AgentToolStatus,
  id = "tc2",
): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date("2024-01-01"),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "Read",
        status,
        error: null,
        detail: {
          type: "read",
          filePath,
          ...(content !== undefined ? { content } : {}),
        },
        metadata: undefined,
      },
    },
  };
}

function makeOrchestratorToolCall(
  toolName: string,
  args: unknown,
  result: unknown,
  status: "executing" | "completed" | "failed",
  id = "otc1",
): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date("2024-01-01"),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName,
        arguments: args,
        result,
        error: status === "failed" ? "Orchestrator error" : undefined,
        status,
      },
    },
  };
}

// ---- extractSearchText tests ----

describe("extractSearchText", () => {
  describe("prompts filter", () => {
    it("matches user messages", () => {
      const item = makeUserMessage("hello world");
      expect(extractSearchText(item, "prompts")).toBe("hello world");
    });

    it("excludes assistant messages", () => {
      const item = makeAssistantMessage("I will help you");
      expect(extractSearchText(item, "prompts")).toBeNull();
    });

    it("excludes tool calls", () => {
      const item = makeShellToolCall("Bash", "ls -la", "file.txt", "completed");
      expect(extractSearchText(item, "prompts")).toBeNull();
    });
  });

  describe("messages filter", () => {
    it("excludes user messages", () => {
      const item = makeUserMessage("hello world");
      expect(extractSearchText(item, "messages")).toBeNull();
    });

    it("matches assistant messages", () => {
      const item = makeAssistantMessage("I will help you");
      expect(extractSearchText(item, "messages")).toBe("I will help you");
    });

    it("matches thoughts", () => {
      const item = makeThought("Thinking about approach");
      expect(extractSearchText(item, "messages")).toBe("Thinking about approach");
    });

    it("matches todos", () => {
      const item = makeTodo(["Step one", "Step two"]);
      expect(extractSearchText(item, "messages")).toBe("Step one Step two");
    });

    it("excludes tool calls", () => {
      const item = makeShellToolCall("Bash", "ls -la", "file.txt", "completed");
      expect(extractSearchText(item, "messages")).toBeNull();
    });

    it("excludes error activity logs", () => {
      const item = makeActivityLog("Something failed", "error");
      expect(extractSearchText(item, "messages")).toBeNull();
    });
  });

  describe("toolCalls filter (input only)", () => {
    it("returns tool name + command for shell calls", () => {
      const item = makeShellToolCall("Bash", "npm test", "✓ passed", "completed");
      const text = extractSearchText(item, "toolCalls");
      expect(text).toContain("Bash");
      expect(text).toContain("npm test");
      // Must NOT include the output
      expect(text).not.toContain("✓ passed");
    });

    it("returns file path for read calls", () => {
      const item = makeReadToolCall("src/app.ts", "const x = 1;", "completed");
      const text = extractSearchText(item, "toolCalls");
      expect(text).toContain("src/app.ts");
      expect(text).not.toContain("const x = 1");
    });

    it("excludes messages", () => {
      const item = makeUserMessage("hello");
      expect(extractSearchText(item, "toolCalls")).toBeNull();
    });

    it("includes failed tool calls (by input)", () => {
      const item = makeShellToolCall("Bash", "broken-cmd", undefined, "failed");
      const text = extractSearchText(item, "toolCalls");
      expect(text).toContain("broken-cmd");
    });

    it("returns tool name and args for orchestrator calls", () => {
      const item = makeOrchestratorToolCall(
        "create_agent",
        { prompt: "do task" },
        null,
        "executing",
      );
      const text = extractSearchText(item, "toolCalls");
      expect(text).toContain("create_agent");
      expect(text).toContain("do task");
    });
  });

  describe("toolOutput filter (completed outputs only)", () => {
    it("returns shell output for completed calls", () => {
      const item = makeShellToolCall("Bash", "ls", "file1.txt\nfile2.txt", "completed");
      const text = extractSearchText(item, "toolOutput");
      expect(text).toContain("file1.txt");
      expect(text).toContain("file2.txt");
      // Must NOT include the input command
      expect(text).not.toContain("ls");
    });

    it("returns null for running calls", () => {
      const item = makeShellToolCall("Bash", "long-task", undefined, "running");
      expect(extractSearchText(item, "toolOutput")).toBeNull();
    });

    it("returns null for failed calls", () => {
      const item = makeShellToolCall("Bash", "bad-cmd", undefined, "failed");
      expect(extractSearchText(item, "toolOutput")).toBeNull();
    });

    it("returns file content for completed read calls", () => {
      const item = makeReadToolCall("package.json", '{"name":"paseo"}', "completed");
      const text = extractSearchText(item, "toolOutput");
      expect(text).toContain("paseo");
      expect(text).not.toContain("package.json");
    });

    it("returns orchestrator result for completed calls", () => {
      const item = makeOrchestratorToolCall("get_data", {}, { result: "found" }, "completed");
      const text = extractSearchText(item, "toolOutput");
      expect(text).toContain("found");
    });

    it("excludes messages", () => {
      const item = makeAssistantMessage("hello");
      expect(extractSearchText(item, "toolOutput")).toBeNull();
    });
  });

  describe("errors filter", () => {
    it("matches failed tool calls", () => {
      const item = makeShellToolCall("Bash", "broken", undefined, "failed");
      const text = extractSearchText(item, "errors");
      expect(text).toContain("Bash");
      expect(text).toContain("Command failed");
    });

    it("matches canceled tool calls", () => {
      const item = makeShellToolCall("Bash", "interrupted-cmd", undefined, "canceled");
      const text = extractSearchText(item, "errors");
      expect(text).toContain("Bash");
    });

    it("excludes completed tool calls", () => {
      const item = makeShellToolCall("Bash", "ok-cmd", "output", "completed");
      expect(extractSearchText(item, "errors")).toBeNull();
    });

    it("matches error activity logs", () => {
      const item = makeActivityLog("Connection refused", "error");
      expect(extractSearchText(item, "errors")).toBe("Connection refused");
    });

    it("excludes non-error activity logs", () => {
      const item = makeActivityLog("Agent started", "info");
      expect(extractSearchText(item, "errors")).toBeNull();
    });

    it("excludes user messages", () => {
      const item = makeUserMessage("error in my code");
      expect(extractSearchText(item, "errors")).toBeNull();
    });
  });

  describe("all filter", () => {
    it("includes user messages", () => {
      const item = makeUserMessage("hello");
      expect(extractSearchText(item, "all")).toBe("hello");
    });

    it("includes tool call name + input for completed call", () => {
      const item = makeShellToolCall("Bash", "ls", "output text", "completed");
      const text = extractSearchText(item, "all");
      expect(text).toContain("Bash");
      expect(text).toContain("ls");
      expect(text).toContain("output text");
    });

    it("includes both input and error for failed call", () => {
      const item = makeShellToolCall("Bash", "bad", undefined, "failed");
      const text = extractSearchText(item, "all");
      expect(text).toContain("bad");
      expect(text).toContain("Command failed");
    });

    it("includes activity logs", () => {
      const item = makeActivityLog("Agent stopped", "info");
      expect(extractSearchText(item, "all")).toBe("Agent stopped");
    });

    it("returns null for compaction", () => {
      const item: StreamItem = {
        kind: "compaction",
        id: "c1",
        timestamp: new Date(),
        status: "completed",
      };
      expect(extractSearchText(item, "all")).toBeNull();
    });
  });
});

// ---- searchItems tests ----

describe("searchItems", () => {
  const items: StreamItem[] = [
    makeUserMessage("Deploy to production", "u1"),
    makeAssistantMessage("I will deploy it now", "a1"),
    makeShellToolCall("Bash", "npm run build", "Build succeeded", "completed", "tc1"),
    makeShellToolCall("Bash", "npm run deploy", undefined, "failed", "tc2"),
    makeActivityLog("Deployment failed: timeout", "error", "log1"),
  ];

  it("returns empty array for empty query", () => {
    expect(searchItems(items, "", "all")).toHaveLength(0);
    expect(searchItems(items, "   ", "all")).toHaveLength(0);
  });

  it("matches case-insensitively", () => {
    const results = searchItems(items, "DEPLOY", "all");
    expect(results.length).toBeGreaterThan(0);
  });

  it("finds the user message among the matches", () => {
    const results = searchItems(items, "Deploy", "all");
    const userMatch = results.find((r) => r.item.kind === "user_message");
    expect(userMatch).toBeDefined();
  });

  it("agrees with highlighting on Unicode case folding (İstanbul vs i)", () => {
    // "İstanbul".toLowerCase() contains "i", but the Unicode-aware regex used
    // for highlighting does not match "İ" against /i/giu — detection must
    // agree with highlighting, so this must NOT match.
    const unicodeItems: StreamItem[] = [makeUserMessage("İstanbul travel plans", "u9")];
    const results = searchItems(unicodeItems, "i", "all");
    expect(results).toHaveLength(0);
  });

  it("still matches plain ASCII case-insensitively (agrees with highlighting)", () => {
    const asciiItems: StreamItem[] = [makeUserMessage("Istanbul travel plans", "u9")];
    const results = searchItems(asciiItems, "i", "all");
    expect(results).toHaveLength(1);
  });

  it("returns one navigable match per occurrence, including repeats within one item", () => {
    // Regression: an item containing the query more than once used to collapse to
    // a single match, so you couldn't cycle to (or even see) the later hits.
    const multi: StreamItem[] = [
      makeUserMessage("write a huge wall of text", "u1"),
      makeAssistantMessage("this huge wall of text is a large wall of text", "a1"),
    ];
    const results = searchItems(multi, "wall", "all");

    // 1 hit in the prompt + 2 hits in the assistant reply = 3 navigable matches.
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.item.id)).toEqual(["u1", "a1", "a1"]);

    // The two assistant occurrences are distinct, ordered by position, and each
    // carries its own occurrence index for a stable key.
    const assistant = results.filter((r) => r.item.id === "a1");
    expect(assistant.map((r) => r.occurrenceIndex)).toEqual([0, 1]);
    expect(assistant[0]!.matchOffset).toBeLessThan(assistant[1]!.matchOffset);
  });

  it("cycles through every occurrence, wrapping past the last", () => {
    const model = createTimelineSearchModel(() => [
      makeUserMessage("write a huge wall of text", "u1"),
      makeAssistantMessage("this huge wall of text is a large wall of text", "a1"),
    ]);
    model.open();
    model.setQuery("wall");

    expect(model.getState().matches).toHaveLength(3);
    expect(model.getState().selectedIndex).toBe(0);
    model.selectNext();
    expect(model.getState().selectedIndex).toBe(1);
    model.selectNext();
    expect(model.getState().selectedIndex).toBe(2);
    model.selectNext();
    expect(model.getState().selectedIndex).toBe(0); // wraps
  });

  it("filters to messages only", () => {
    const results = searchItems(items, "deploy", "messages");
    const kinds = results.map((r) => r.item.kind);
    expect(kinds).not.toContain("tool_call");
    expect(kinds).not.toContain("activity_log");
  });

  it("filters to toolCalls only", () => {
    const results = searchItems(items, "build", "toolCalls");
    expect(results.every((r) => r.item.kind === "tool_call")).toBe(true);
    // Should match the npm run build command (input)
    expect(results.some((r) => r.snippet.includes("npm run build"))).toBe(true);
    // Should NOT match the successful output text
    expect(results.some((r) => r.snippet.includes("succeeded"))).toBe(false);
  });

  it("filters to toolOutput for completed calls", () => {
    const results = searchItems(items, "succeeded", "toolOutput");
    expect(results.length).toBe(1);
    expect(results[0]?.item.kind).toBe("tool_call");
  });

  it("filters to errors only", () => {
    const results = searchItems(items, "deploy", "errors");
    // Only failed tool call + error activity log
    expect(
      results.every((r) => {
        if (r.item.kind === "tool_call") {
          const data = r.item.payload.data;
          return data.status === "failed" || data.status === "canceled";
        }
        if (r.item.kind === "activity_log") {
          return r.item.activityType === "error";
        }
        return false;
      }),
    ).toBe(true);
  });

  it("returns snippet truncated to ~80 chars", () => {
    const longText = "x".repeat(200);
    const longItems: StreamItem[] = [makeUserMessage(longText)];
    const results = searchItems(longItems, "x", "all");
    expect(results[0]?.snippet.length).toBeLessThanOrEqual(81);
  });

  it("keeps an early match head-anchored and unchanged", () => {
    const text = `needle right at the start, then padding ${"x".repeat(100)}`;
    const earlyItems: StreamItem[] = [makeUserMessage(text)];
    const results = searchItems(earlyItems, "needle", "all");
    expect(results[0]?.snippet.startsWith("needle right at the start")).toBe(true);
    expect(results[0]?.snippet.endsWith("…")).toBe(true);
  });

  it("centers the snippet on a deep match so the query text is included", () => {
    const text = `${"x".repeat(150)} needle-is-here ${"y".repeat(50)}`;
    const deepItems: StreamItem[] = [makeUserMessage(text)];
    const results = searchItems(deepItems, "needle-is-here", "all");
    const snippet = results[0]?.snippet ?? "";
    expect(snippet).toContain("needle-is-here");
    expect(snippet.startsWith("…")).toBe(true);
  });
});

// ---- createTimelineSearchModel tests ----

describe("createTimelineSearchModel", () => {
  let items: StreamItem[];
  let model: ReturnType<typeof createTimelineSearchModel>;

  beforeEach(() => {
    items = [
      makeUserMessage("hello world", "u1"),
      makeAssistantMessage("goodbye world", "a1"),
      makeShellToolCall("Bash", "echo hello", "hello\n", "completed", "tc1"),
    ];
    model = createTimelineSearchModel(() => items);
  });

  it("starts closed with empty query", () => {
    const state = model.getState();
    expect(state.isOpen).toBe(false);
    expect(state.query).toBe("");
    expect(state.matches).toHaveLength(0);
    expect(state.selectedIndex).toBe(-1);
  });

  it("open() sets isOpen = true and recomputes matches", () => {
    model.setQuery("hello");
    model.open();
    const state = model.getState();
    expect(state.isOpen).toBe(true);
    expect(state.matches.length).toBeGreaterThan(0);
  });

  it("close() sets isOpen = false without clearing query", () => {
    model.setQuery("hello");
    model.open();
    model.close();
    const state = model.getState();
    expect(state.isOpen).toBe(false);
    expect(state.query).toBe("hello"); // query preserved
  });

  it("setQuery recomputes matches and selects first", () => {
    model.setQuery("world");
    const state = model.getState();
    expect(state.matches.length).toBe(2); // user + assistant
    expect(state.selectedIndex).toBe(0);
  });

  it("setQuery with no matches sets selectedIndex = -1", () => {
    model.setQuery("zzznomatch");
    expect(model.getState().selectedIndex).toBe(-1);
  });

  it("selectNext wraps around", () => {
    model.setQuery("world");
    model.selectNext();
    expect(model.getState().selectedIndex).toBe(1);
    model.selectNext();
    expect(model.getState().selectedIndex).toBe(0); // wraps
  });

  it("selectPrev wraps around", () => {
    model.setQuery("world");
    model.selectPrev();
    const state = model.getState();
    // wraps to last (index 1 for 2 matches)
    expect(state.selectedIndex).toBe(1);
  });

  it("selectIndex sets to specific index", () => {
    model.setQuery("world");
    model.selectIndex(1);
    expect(model.getState().selectedIndex).toBe(1);
  });

  it("selectIndex ignores out-of-range indices", () => {
    model.setQuery("world");
    model.selectIndex(99);
    expect(model.getState().selectedIndex).toBe(0); // unchanged
  });

  it("setFilter recomputes matches", () => {
    model.setQuery("hello");
    model.setFilter("toolCalls");
    const state = model.getState();
    // Only the shell tool call input should match "hello"
    expect(state.matches.every((m) => m.item.kind === "tool_call")).toBe(true);
  });

  it("subscribe notifies on state changes", () => {
    let callCount = 0;
    const unsub = model.subscribe(() => {
      callCount++;
    });
    model.setQuery("world");
    model.setFilter("messages");
    model.open();
    model.close();
    expect(callCount).toBe(4);
    unsub();
    model.setQuery("changed");
    expect(callCount).toBe(4); // no more calls after unsub
  });

  it("subscribe does not notify when query is unchanged", () => {
    let callCount = 0;
    model.subscribe(() => {
      callCount++;
    });
    model.setQuery("hello");
    model.setQuery("hello"); // same query
    expect(callCount).toBe(1);
  });

  it("open() recomputes against current items snapshot", () => {
    model.setQuery("newitem");
    // no results yet
    expect(model.getState().matches).toHaveLength(0);
    // add a new item to the live array
    items.push(makeUserMessage("this is a newitem added live", "u2"));
    model.open();
    expect(model.getState().matches.length).toBeGreaterThan(0);
  });

  describe("refresh", () => {
    it("recomputes matches against the latest items snapshot", () => {
      model.setQuery("newitem");
      expect(model.getState().matches).toHaveLength(0);
      items.push(makeUserMessage("this is a newitem added live", "u2"));
      model.refresh();
      expect(model.getState().matches.length).toBeGreaterThan(0);
    });

    it("preserves the current selection when the selected match still exists", () => {
      model.setQuery("world");
      model.selectIndex(1); // assistant "goodbye world"
      const selectedId = model.getState().matches[1]?.item.id;
      expect(selectedId).toBe("a1");

      // Prepend a new matching item so match order shifts.
      items.unshift(makeUserMessage("world tour announcement", "u0"));
      model.refresh();

      const state = model.getState();
      expect(state.matches.length).toBe(3);
      expect(state.matches[state.selectedIndex]?.item.id).toBe("a1");
    });

    it("falls back to the first match when the previously selected item is gone", () => {
      model.setQuery("world");
      model.selectIndex(1); // assistant "goodbye world"
      items = items.filter(isNotId("a1"));
      model.refresh();
      const state = model.getState();
      expect(state.matches).toHaveLength(1);
      expect(state.selectedIndex).toBe(0);
      expect(state.matches[0]?.item.id).toBe("u1");
    });

    it("sets selectedIndex to -1 when no matches remain", () => {
      model.setQuery("world");
      items.length = 0;
      model.refresh();
      const state = model.getState();
      expect(state.matches).toHaveLength(0);
      expect(state.selectedIndex).toBe(-1);
    });

    it("notifies subscribers when the refreshed matches actually change", () => {
      model.setQuery("newitem");
      let callCount = 0;
      const increment = () => {
        callCount++;
      };
      model.subscribe(increment);
      items.push(makeUserMessage("this is a newitem added live", "u2"));
      model.refresh();
      expect(callCount).toBe(1);
    });

    it("does not notify subscribers when refresh finds the same id-equal matches", () => {
      let callCount = 0;
      const increment = () => {
        callCount++;
      };
      model.subscribe(increment);
      // No query set and no item changes — refresh() recomputes to the same
      // (empty) matches array, so subscribers must not be notified.
      model.refresh();
      expect(callCount).toBe(0);
    });

    it("keeps the matches array identity and does not notify when the refreshed matches are id-equal", () => {
      model.setQuery("world");
      const matchesBefore = model.getState().matches;

      let callCount = 0;
      const increment = () => {
        callCount++;
      };
      model.subscribe(increment);

      // No structural change to the underlying items — refresh() re-runs the
      // search, producing a new array with the same item ids in the same
      // order (simulating an unrelated streaming token arriving elsewhere).
      model.refresh();

      const state = model.getState();
      expect(state.matches).toBe(matchesBefore);
      expect(callCount).toBe(0);
    });
  });

  describe("navigationRevision", () => {
    it("starts at 0", () => {
      expect(model.getState().navigationRevision).toBe(0);
    });

    it("bumps on open()", () => {
      model.setQuery("world");
      const before = model.getState().navigationRevision;
      model.open();
      expect(model.getState().navigationRevision).toBe(before + 1);
    });

    it("bumps on selectNext() even with a single match", () => {
      model.setQuery("hello world");
      expect(model.getState().matches.length).toBe(1); // only the user message matches
      const before = model.getState().navigationRevision;
      const indexBefore = model.getState().selectedIndex;

      model.selectNext();

      const state = model.getState();
      // Index is unchanged (wraps back to the same single match)...
      expect(state.selectedIndex).toBe(indexBefore);
      // ...but the revision still bumps so the scroll effect re-fires.
      expect(state.navigationRevision).toBe(before + 1);
    });

    it("bumps on selectPrev() even with a single match", () => {
      model.setQuery("hello world");
      const before = model.getState().navigationRevision;
      model.selectPrev();
      expect(model.getState().navigationRevision).toBe(before + 1);
    });

    it("bumps on selectIndex() even when the index is unchanged", () => {
      model.setQuery("world");
      const currentIndex = model.getState().selectedIndex;
      const before = model.getState().navigationRevision;

      model.selectIndex(currentIndex);

      expect(model.getState().navigationRevision).toBe(before + 1);
    });

    it("does not bump on refresh()", () => {
      model.setQuery("world");
      const before = model.getState().navigationRevision;
      model.refresh();
      expect(model.getState().navigationRevision).toBe(before);
    });

    it("notifies subscribers on same-index selectIndex()", () => {
      model.setQuery("world");
      const currentIndex = model.getState().selectedIndex;
      let callCount = 0;
      const increment = () => {
        callCount++;
      };
      model.subscribe(increment);
      model.selectIndex(currentIndex);
      expect(callCount).toBe(1);
    });
  });
});
