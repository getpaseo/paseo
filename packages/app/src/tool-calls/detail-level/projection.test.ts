import { describe, expect, it, vi } from "vitest";
import * as markdownSource from "@/components/markdown/source";
import { resolveToolCallImage } from "./overview/image-source";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { getToolCallImagePreview } from "./overview/model";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
  type PreparedToolCallHistory,
  type ToolCallDetailLevel,
} from "./projection";

type AssistantMessageItem = Extract<StreamItem, { kind: "assistant_message" }>;
const PROVIDER_IMAGE_MARKDOWN = `\n\n![Image](file:///tmp/paseo-attachments-test/${"a".repeat(64)}.png)\n\n`;

function toolCall(
  id: string,
  detail: ToolCallDetail,
  options: {
    name?: string;
    status?: "running" | "completed" | "failed" | "canceled";
  } = {},
): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(`2026-01-01T00:00:${id.padStart(2, "0")}.000Z`),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: options.name ?? detail.type,
        status: options.status ?? "completed",
        error: options.status === "failed" ? "boom" : null,
        detail,
      },
    },
  };
}

function assistant(id: string): AssistantMessageItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: new Date("2026-01-01T00:01:00.000Z"),
  };
}

function project(input: {
  level: ToolCallDetailLevel;
  tail?: StreamItem[];
  head?: StreamItem[];
  isTurnActive?: boolean;
  preparedHistory?: PreparedToolCallHistory | null;
}) {
  const tail = input.tail ?? [];
  return projectToolCallDetailLevel({
    level: input.level,
    tail,
    head: input.head ?? [],
    preparedHistory: input.preparedHistory ?? prepareToolCallHistory(input.level, tail),
    isTurnActive: input.isTurnActive ?? false,
  });
}

describe("tool call detail-level projection", () => {
  it("provides ordered image thumbnails with their preceding tool names", () => {
    const first = toolCall("1", { type: "read", filePath: "/repo/first.png" }, { name: "Read" });
    const image = { ...assistant("image"), text: PROVIDER_IMAGE_MARKDOWN };
    const second = toolCall("2", { type: "shell", command: "capture" }, { name: "Bash" });
    const nextImage = { ...assistant("next-image"), text: PROVIDER_IMAGE_MARKDOWN };
    const result = project({ level: "overview", tail: [first, image, second, nextImage] });

    expect(result.groupsByHostId.get(first.id)?.images).toEqual([
      {
        id: "image:0",
        itemId: "image",
        message: image,
        index: 0,
        toolName: "Read",
      },
      {
        id: "next-image:0",
        itemId: "next-image",
        message: nextImage,
        index: 0,
        toolName: "Bash",
      },
    ]);
  });

  it.each([
    { total: 1, visible: [1], hidden: 0 },
    { total: 3, visible: [1, 2, 3], hidden: 0 },
    { total: 10, visible: [8, 9, 10], hidden: 7 },
    { total: 11, visible: [9, 10, 11], hidden: 8 },
  ])(
    "limits the summary for $total merged image outputs without losing their order",
    ({ total, visible, hidden }) => {
      const call = toolCall("1", { type: "read", filePath: "/repo/book.pdf" }, { name: "Read" });
      const pages = Array.from(
        { length: total },
        (_, index) =>
          `![Page ${index + 1}](file:///tmp/paseo-attachments-test/${index.toString(16).padStart(64, "0")}.png)`,
      );
      const message = { ...assistant("pages"), text: pages.join("\n\n") };
      const result = project({ level: "overview", tail: [call], head: [message] });
      const group = result.groupsByHostId.get(call.id);
      if (!group) throw new Error("Expected a group containing the image outputs");
      expect(group.images).toHaveLength(total);
      expect(new Set(group.images.map((image) => image.id)).size).toBe(total);
      expect(group.images.map((image) => image.toolName)).toEqual(Array(total).fill("Read"));
      const preview = getToolCallImagePreview(group.images);
      expect(preview.hiddenCount).toBe(hidden);
      expect(preview.visible.map((image) => resolveToolCallImage(image).alt)).toEqual(
        visible.map((page) => `Page ${page}`),
      );
      expect(group.run.calls).toEqual([call, message]);
    },
  );

  it.each([false, true])(
    "parses only visible image messages and reuses parsed sources (merged %s)",
    (merged) => {
      const parse = vi.spyOn(markdownSource, "prepareMarkdownSource");
      try {
        const call = toolCall("1", { type: "read", filePath: "/repo/book.pdf" }, { name: "Read" });
        const messages = merged
          ? [{ ...assistant("pages"), text: PROVIDER_IMAGE_MARKDOWN.repeat(11) }]
          : Array.from({ length: 11 }, (_, index) => ({
              ...assistant(`page-${index}`),
              text: PROVIDER_IMAGE_MARKDOWN,
            }));
        const result = project({ level: "overview", tail: [call, ...messages] });
        const group = result.groupsByHostId.get(call.id);
        if (!group) throw new Error("Expected image group");
        expect(parse).not.toHaveBeenCalled();
        const preview = getToolCallImagePreview(group.images);
        for (const image of preview.visible) {
          expect(resolveToolCallImage(image)).toMatchObject({
            source: `file:///tmp/paseo-attachments-test/${"a".repeat(64)}.png`,
            alt: "Image",
          });
          expect(resolveToolCallImage(image)).toBe(resolveToolCallImage(image));
        }
        expect(parse).toHaveBeenCalledTimes(merged ? 1 : 3);
      } finally {
        parse.mockRestore();
      }
    },
  );

  it("does not invent a tool name for an image following reasoning alone", () => {
    const thought: StreamItem = {
      kind: "thought",
      id: "thought",
      text: "Reviewing",
      status: "ready",
      timestamp: new Date(0),
    };
    const image = { ...assistant("image"), text: PROVIDER_IMAGE_MARKDOWN };
    const result = project({ level: "overview", tail: [thought, image] });
    expect(result.groupsByHostId.get(thought.id)?.images).toMatchObject([
      { itemId: image.id, message: image, index: 0, toolName: null },
    ]);
  });

  it.each([0, 1, 2, 3])(
    "keeps provider images inside the tool run with %i retained items",
    (retainedCount) => {
      const first = toolCall("1", { type: "read", filePath: "/repo/first.png" });
      const image = {
        ...assistant("image"),
        text: PROVIDER_IMAGE_MARKDOWN,
      };
      const second = toolCall("2", { type: "read", filePath: "/repo/second.png" });
      const items = [first, image, second];
      const result = project({
        level: "overview",
        tail: items.slice(0, retainedCount),
        head: items.slice(retainedCount),
      });

      expect([...result.tail, ...result.head].map((item) => item.id)).toEqual([first.id]);
      expect(result.groupsByHostId.get(first.id)?.run.calls).toEqual(items);
      expect(result.groupsByHostId.get(first.id)?.summary).toMatchObject({
        readFileCount: 2,
        otherToolCount: 0,
      });
    },
  );

  it.each([0, 1, 2, 3])(
    "keeps trailing images folded under a tool host with %i retained items",
    (retainedCount) => {
      const call = toolCall("1", { type: "read", filePath: "/repo/first.png" });
      const image = { ...assistant("image"), text: PROVIDER_IMAGE_MARKDOWN };
      const images = { ...assistant("images"), text: PROVIDER_IMAGE_MARKDOWN.repeat(2) };
      const items = [call, image, images];
      const tail = items.slice(0, retainedCount);
      const result = project({
        level: "overview",
        tail,
        head: items.slice(retainedCount),
        preparedHistory: prepareToolCallHistory("overview", tail, true),
        isTurnActive: true,
      });

      expect([...result.tail, ...result.head]).toEqual([call]);
      expect(result.groupsByHostId.get(call.id)).toMatchObject({
        run: { calls: items, latest: call, isSealed: false },
        summary: { readFileCount: 1, otherToolCount: 0 },
        isLoading: false,
      });
      expect(project({ level: "detailed", tail: items }).tail).toEqual(items);
    },
  );

  it.each([
    "![Image](https://example.com/image.png)",
    "![Image](/repo/first.png)",
    `Description before${PROVIDER_IMAGE_MARKDOWN}`,
    `${PROVIDER_IMAGE_MARKDOWN}Description after`,
    `\`\`\`markdown\n${PROVIDER_IMAGE_MARKDOWN}\n\`\`\``,
  ])("keeps ordinary images and mixed prose outside groups: %s", (text) => {
    const first = toolCall("1", { type: "read", filePath: "/repo/first.png" });
    const message = { ...assistant("message"), text };
    const second = toolCall("2", { type: "read", filePath: "/repo/second.png" });
    const items = [first, message, second];
    const history = project({ level: "overview", tail: items });
    const live = project({ level: "overview", tail: [first], head: [message, second] });

    expect(history.tail).toEqual(items);
    expect(history.groupsByHostId.size).toBe(0);
    expect([...live.tail, ...live.head]).toEqual(items);
    expect(live.groupsByHostId.size).toBe(0);
  });

  it("does not start a group with an image or absorb a user-authored image", () => {
    const image = { ...assistant("image"), text: PROVIDER_IMAGE_MARKDOWN };
    const user: StreamItem = { ...image, kind: "user_message", id: "user" };
    const call = toolCall("1", { type: "read", filePath: "/repo/first.png" });
    const items = [image, call, user];

    expect(project({ level: "overview", tail: items }).tail).toEqual(items);
    expect(project({ level: "overview", head: items }).head).toEqual(items);
  });

  it("does not attach an image across canonical turns", () => {
    const call = {
      ...toolCall("1", { type: "read", filePath: "/repo/first.png" }),
      turnId: "first",
    };
    const image = { ...assistant("image"), text: PROVIDER_IMAGE_MARKDOWN, turnId: "second" };

    expect(project({ level: "overview", tail: [call, image] }).tail).toEqual([call, image]);
    const live = project({ level: "overview", tail: [call], head: [image] });
    expect(live.head).toEqual([image]);
    expect(live.groupsByHostId.size).toBe(0);
  });

  it.each([false, true])(
    "respects reasoning boundaries before images (Expand thinking %s)",
    (autoExpandReasoning) => {
      const thought: StreamItem = {
        kind: "thought",
        id: "reasoning",
        text: "Inspecting the image",
        status: "ready",
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
      };
      const image = { ...assistant("image"), text: PROVIDER_IMAGE_MARKDOWN };
      const tail = [thought];
      const result = project({
        level: "overview",
        tail,
        head: [image],
        preparedHistory: prepareToolCallHistory("overview", tail, autoExpandReasoning),
      });
      expect(result.tail).toEqual([thought]);
      expect(result.head).toEqual(autoExpandReasoning ? [image] : []);
      expect(result.groupsByHostId.get(thought.id)?.run.calls).toEqual(
        autoExpandReasoning ? undefined : [thought, image],
      );
    },
  );

  it.each(["detailed", "overview"] as const)(
    "keeps pending approval tools out of %s presentation without removing their canonical position",
    (level) => {
      const pending = toolCall(
        "1",
        { type: "plan", text: "Ship it" },
        { name: "ExitPlanMode", status: "running" },
      );
      const followUp = {
        kind: "user_message",
        id: "question",
        text: "What about tests?",
        timestamp: new Date(2),
      } satisfies StreamItem;
      const tail = [pending, followUp];
      expect(project({ level, tail }).tail).toEqual([followUp]);
      expect(tail).toEqual([pending, followUp]);
      const rejected = toolCall("1", { type: "plan", text: "Ship it" }, { name: "plan_approval" });
      expect(project({ level, tail: [rejected, followUp] }).tail).toEqual([rejected, followUp]);
    },
  );

  it("passes detailed timelines through without grouping work", () => {
    const tail = [toolCall("1", { type: "shell", command: "one" })];
    const head = [toolCall("2", { type: "shell", command: "two" })];

    const prepared = prepareToolCallHistory("detailed", tail);
    const result = project({ level: "detailed", tail, head, preparedHistory: prepared });

    expect(prepared).toBeNull();
    expect(result.tail).toBe(tail);
    expect(result.head).toBe(head);
    expect(result.groupsByHostId.size).toBe(0);
  });

  it("keeps one stable overview host as a run grows", () => {
    const firstCall = toolCall("1", { type: "shell", command: "one" });
    const secondCall = toolCall("2", { type: "read", filePath: "/repo/a.ts" });
    const prepared = prepareToolCallHistory("overview", []);

    const single = project({
      level: "overview",
      head: [firstCall],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    expect(single.head).toEqual([firstCall]);
    expect(single.groupsByHostId.size).toBe(0);

    const grouped = project({
      level: "overview",
      head: [firstCall, secondCall],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    expect(grouped.head).toEqual([
      expect.objectContaining({ id: firstCall.id, timestamp: secondCall.timestamp }),
    ]);
    expect(grouped.groupsByHostId.get(firstCall.id)?.run).toMatchObject({
      calls: [firstCall, secondCall],
      latest: secondCall,
      isSealed: false,
    });
  });

  it("keeps a parallel group loading while any call is still running", () => {
    const calls = [
      toolCall("1", { type: "shell", command: "slow" }, { status: "running" }),
      toolCall("2", { type: "shell", command: "done" }),
    ];
    const result = project({ level: "overview", head: calls, isTurnActive: true });

    expect(result.groupsByHostId.get("1")?.isLoading).toBe(true);
  });

  it("leaves a running lone call visible without an aggregate", () => {
    const call = toolCall("1", { type: "shell", command: "one" }, { status: "running" });
    const result = project({ level: "overview", head: [call], isTurnActive: true });
    expect(result.head).toEqual([call]);
    expect(result.groupsByHostId.size).toBe(0);
  });

  it("keeps an active overview group on its latest call until a visible boundary arrives", () => {
    const calls = [
      toolCall("1", { type: "shell", command: "one" }),
      toolCall("2", { type: "read", filePath: "/repo/a.ts" }),
      toolCall("3", { type: "read", filePath: "/repo/b.ts" }),
      toolCall("4", { type: "edit", filePath: "/repo/a.ts" }),
    ];
    const prepared = prepareToolCallHistory("overview", []);
    const active = project({
      level: "overview",
      head: calls,
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const activeGroup = active.groupsByHostId.get("1");

    expect(activeGroup).toMatchObject({
      mode: "overview",
      run: { id: "1", latest: calls[3], isSealed: false },
    });
    const boundary = assistant("answer");
    const sealed = project({
      level: "overview",
      head: [...calls, boundary],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    expect(sealed.groupsByHostId.get("1")).toMatchObject({
      mode: "overview",
      run: { latest: calls[3], isSealed: true },
      summary: { editedFileCount: 1, readFileCount: 2, commandCount: 1 },
    });
  });

  it("keeps a running overview group live before the agent lifecycle catches up", () => {
    const calls = ["1", "2", "3", "4"].map((id) =>
      toolCall(id, { type: "shell", command: id }, { status: "running" }),
    );

    const result = project({
      level: "overview",
      tail: calls,
      isTurnActive: false,
    });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      run: { latest: calls[3], isSealed: false },
      isLoading: true,
      summary: { commandCount: 4 },
    });
  });

  it("seals the trailing overview group only when the turn ends", () => {
    const calls = ["1", "2", "3", "4"].map((id) => toolCall(id, { type: "shell", command: id }));
    const prepared = prepareToolCallHistory("overview", []);

    const betweenCalls = project({
      level: "overview",
      head: calls,
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const nextCall = toolCall("5", { type: "read", filePath: "/repo/a.ts" });
    const continued = project({
      level: "overview",
      head: [...calls, nextCall],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const ended = project({
      level: "overview",
      head: [...calls, nextCall],
      isTurnActive: false,
      preparedHistory: prepared,
    });

    expect(betweenCalls.groupsByHostId.get("1")?.run.isSealed).toBe(false);
    expect(continued.groupsByHostId.get("1")?.run).toMatchObject({
      latest: nextCall,
      isSealed: false,
    });
    expect(ended.groupsByHostId.get("1")?.run.isSealed).toBe(true);
  });

  it("builds overview summaries without category-specific presentation data", () => {
    const calls = [
      toolCall("1", { type: "read", filePath: "/repo/src/a.ts" }),
      toolCall("2", { type: "read", filePath: "/repo/src/b.ts" }),
      toolCall("3", { type: "shell", command: "npm test" }),
      toolCall("4", { type: "edit", filePath: "/repo/src/a.ts" }, { status: "failed" }),
    ];

    const overview = project({ level: "overview", head: calls });

    expect(overview.groupsByHostId.get("1")).toEqual({
      mode: "overview",
      run: expect.any(Object),
      isLoading: false,
      images: [],
      summary: {
        thoughtCount: 0,
        editedFileCount: 1,
        commandCount: 1,
        readFileCount: 2,
        searchCount: 0,
        otherToolCount: 0,
        paseoActions: {},
      },
    });
  });

  it("distinguishes reads, searches, and other tools in overview", () => {
    const calls = [
      toolCall("1", { type: "read", filePath: "/repo/src/a.ts" }),
      toolCall("2", { type: "read", filePath: "C:\\repo\\src\\beta.ts" }),
      toolCall("3", { type: "fetch", url: "https://github.com/org/repo" }),
      toolCall(
        "4",
        { type: "search", query: "paseo", toolName: "web_search" },
        { status: "failed" },
      ),
      toolCall("5", { type: "fetch", url: "not a url" }),
    ];

    const result = project({ level: "overview", head: calls });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      summary: {
        editedFileCount: 0,
        commandCount: 0,
        readFileCount: 2,
        searchCount: 1,
        otherToolCount: 2,
      },
    });
  });

  it("counts unique edited files and every shell command in overview", () => {
    const calls = [
      toolCall("1", { type: "edit", filePath: "/repo/a.ts" }),
      toolCall("2", { type: "edit", filePath: "/repo/a.ts" }),
      toolCall("3", { type: "write", filePath: "/repo/b.ts" }),
      toolCall("4", { type: "shell", command: "npm test" }),
      toolCall("5", { type: "shell", command: "npm run lint" }),
      toolCall("6", { type: "read", filePath: "/repo/c.ts" }),
    ];

    const result = project({ level: "overview", head: calls });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      summary: {
        editedFileCount: 2,
        commandCount: 2,
        readFileCount: 1,
        otherToolCount: 0,
      },
    });
  });

  it("counts Paseo calls separately from other tools", () => {
    const calls = [
      toolCall("1", { type: "unknown", input: null, output: null }, { name: "paseo.list_agents" }),
      toolCall(
        "2",
        { type: "unknown", input: null, output: null },
        { name: "mcp__paseo__list_worktrees" },
      ),
      toolCall("3", { type: "fetch", url: "https://paseo.sh" }),
      toolCall("4", { type: "fetch", url: "https://github.com/getpaseo" }),
    ];

    const result = project({ level: "overview", head: calls });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      summary: { otherToolCount: 2, paseoActions: { "Listed agents": 1, "List worktrees": 1 } },
    });
  });

  it("classifies direct Brave search and Paseo runtime tool names", () => {
    const unknownDetail = { type: "unknown" as const, input: null, output: null };
    const calls = [
      toolCall("1", unknownDetail, { name: "brave-search_brave_web_search" }),
      toolCall("2", unknownDetail, { name: "brave-search_brave_llm_context" }),
      toolCall("3", unknownDetail, { name: "paseo_list_providers" }),
      toolCall("4", unknownDetail, { name: "paseo_list_worktrees" }),
      toolCall("5", unknownDetail, { name: "paseo_list_worktrees" }),
      toolCall("6", unknownDetail, { name: "mcp__exa__web_search" }),
    ];

    const result = project({ level: "overview", head: calls });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      summary: {
        searchCount: 3,
        otherToolCount: 0,
        paseoActions: { "Listed providers": 1, "List worktrees": 2 },
      },
    });
  });

  it("reuses prepared history and sealed group models across live-head updates", () => {
    const historicalCalls = ["1", "2", "3", "4"].map((id) =>
      toolCall(id, { type: "shell", command: id }),
    );
    const tail = [...historicalCalls, assistant("boundary")];
    const prepared = prepareToolCallHistory("overview", tail);
    if (!prepared) {
      throw new Error("Overview history must be prepared");
    }
    expect(prepared.grouped.tail).toEqual([
      expect.objectContaining({ id: "1", timestamp: historicalCalls[3]?.timestamp }),
      tail[4],
    ]);
    const first = project({
      level: "overview",
      tail,
      head: [toolCall("5", { type: "read", filePath: "/repo/a.ts" })],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const second = project({
      level: "overview",
      tail,
      head: [
        toolCall("5", { type: "read", filePath: "/repo/a.ts" }),
        toolCall("6", { type: "read", filePath: "/repo/b.ts" }),
      ],
      isTurnActive: true,
      preparedHistory: prepared,
    });

    expect(first.tail).toBe(prepared.grouped.tail);
    expect(second.tail).toBe(prepared.grouped.tail);
    expect(first.groupsByHostId.get("1")).toBe(prepared.grouped.groupsByHostId.get("1"));
    expect(second.groupsByHostId.get("1")).toBe(prepared.grouped.groupsByHostId.get("1"));
    expect(first.historyGroupUpdatesByHostId.size).toBe(0);
    expect(second.historyGroupUpdatesByHostId).toBe(first.historyGroupUpdatesByHostId);
    expect(second.groupsByHostId.get("5")?.run.calls).toHaveLength(2);
  });

  it("preserves projected history identity during assistant-only head updates", () => {
    const trailingCalls = [
      toolCall("1", { type: "shell", command: "one" }),
      toolCall("2", { type: "read", filePath: "/repo/a.ts" }),
    ];
    const tail = [assistant("before"), ...trailingCalls];
    const prepared = prepareToolCallHistory("overview", tail);
    if (!prepared) {
      throw new Error("Overview history must be prepared");
    }

    const firstHead = [assistant("answer")];
    const secondHead = [{ ...firstHead[0], text: "answer grows" }];
    const first = project({
      level: "overview",
      tail,
      head: firstHead,
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const second = project({
      level: "overview",
      tail,
      head: secondHead,
      isTurnActive: true,
      preparedHistory: prepared,
    });

    expect(first.tail).toBe(prepared.grouped.tail);
    expect(second.tail).toBe(prepared.grouped.tail);
    expect(first.groupsByHostId).toBe(prepared.grouped.groupsByHostId);
    expect(second.groupsByHostId).toBe(prepared.grouped.groupsByHostId);
    expect(first.historyGroupUpdatesByHostId.size).toBe(0);
    expect(second.historyGroupUpdatesByHostId).toBe(first.historyGroupUpdatesByHostId);
  });

  it("forms one group across the retained-history and live-head boundary", () => {
    const tail = [
      assistant("before"),
      toolCall("1", { type: "shell", command: "one" }),
      toolCall("2", { type: "shell", command: "two" }),
    ];
    const head = [
      toolCall("3", { type: "read", filePath: "/repo/a.ts" }),
      toolCall("4", { type: "edit", filePath: "/repo/a.ts" }, { status: "running" }),
    ];

    const result = project({ level: "overview", tail, head, isTurnActive: true });

    expect(result.tail).toEqual([
      tail[0],
      expect.objectContaining({ id: "1", timestamp: tail[2]?.timestamp }),
    ]);
    expect(result.head).toEqual([]);
    expect(result.groupsByHostId.get("1")?.run).toMatchObject({
      calls: [...tail.slice(1), ...head],
      latest: head[1],
      isSealed: false,
    });
    expect(result.historyGroupUpdatesByHostId.get("1")).toBe(result.groupsByHostId.get("1"));
  });

  it("keeps a trailing history-only group in the retained segment", () => {
    const tail = ["1", "2", "3", "4"].map((id) => toolCall(id, { type: "shell", command: id }));

    const result = project({ level: "overview", tail, isTurnActive: false });

    expect(result.tail).toEqual([
      expect.objectContaining({ id: "1", timestamp: tail[3]?.timestamp }),
    ]);
    expect(result.head).toEqual([]);
    expect(result.groupsByHostId.get("1")?.run.isSealed).toBe(true);
  });

  it("hosts single calls while leaving plans and spoken messages ungrouped", () => {
    const singleCall = toolCall("1", { type: "shell", command: "one" });
    const plan = toolCall("2", { type: "plan", text: "Plan" });
    const speak = toolCall(
      "3",
      { type: "unknown", input: "Hello", output: null },
      { name: "speak" },
    );

    const result = project({ level: "overview", head: [singleCall, plan, speak] });

    expect(result.head).toEqual([singleCall, plan, speak]);
    expect(result.groupsByHostId.size).toBe(0);
  });
});

it("keeps a heartbeat trigger visible outside grouped work", () => {
  const trigger = toolCall(
    "1",
    { type: "plain_text", text: "Check progress" },
    { name: "heartbeat" },
  );
  const work = toolCall("2", { type: "shell", command: "pwd" });
  const result = project({ level: "overview", tail: [trigger, work] });
  expect(result.tail.map((item) => item.id)).toEqual(["1", "2"]);
  expect(result.groupsByHostId.has("1")).toBe(false);
});

it("does not merge tools from different canonical turns", () => {
  const first = toolCall("1", { type: "shell", command: "pwd" });
  first.turnId = "first";
  const second = toolCall("2", { type: "shell", command: "ls" });
  second.turnId = "second";
  const result = project({ level: "overview", tail: [first, second] });
  expect(result.tail.map((item) => item.id)).toEqual(["1", "2"]);
});

it.each([false, true])(
  "handles streaming reasoning across retained history (Expand thinking %s)",
  (autoExpandReasoning) => {
    const call = { ...toolCall("1", { type: "shell", command: "echo ok" }), turnId: "run" };
    const thought: StreamItem = {
      kind: "thought",
      id: "reasoning",
      text: "Checking",
      status: "loading",
      timestamp: new Date(),
      turnId: "run",
    };
    const tail = [call];
    const result = project({
      level: "overview",
      tail,
      head: [thought],
      isTurnActive: true,
      preparedHistory: prepareToolCallHistory("overview", tail, autoExpandReasoning),
    });
    expect(result.head).toEqual(autoExpandReasoning ? [thought] : []);
    expect(result.groupsByHostId.get(call.id)?.run.calls).toEqual(
      autoExpandReasoning ? undefined : [call, thought],
    );
    expect(result.groupsByHostId.get(call.id)?.summary).toEqual(
      autoExpandReasoning
        ? undefined
        : expect.objectContaining({
            commandCount: 1,
            otherToolCount: 0,
            thoughtCount: 1,
          }),
    );
  },
);

it("turns a retained lone call into a group without replacing its row key", () => {
  const first = toolCall("1", { type: "shell", command: "one" });
  const second = toolCall("2", { type: "shell", command: "two" });
  const tail = [assistant("before"), first];
  const preparedHistory = prepareToolCallHistory("overview", tail);
  const single = project({ level: "overview", tail, preparedHistory, isTurnActive: true });
  const grouped = project({
    level: "overview",
    tail,
    head: [second],
    preparedHistory,
    isTurnActive: true,
  });
  expect(single.groupsByHostId.size).toBe(0);
  expect(single.tail).toBe(tail);
  expect(grouped.tail).toBe(single.tail);
  expect(grouped.head).toEqual([]);
  expect(grouped.groupsByHostId.get(first.id)?.run.calls).toEqual([first, second]);
  expect(grouped.historyGroupUpdatesByHostId.get(first.id)).toBe(
    grouped.groupsByHostId.get(first.id),
  );
});

it("shows one thought as itself until another groupable item arrives", () => {
  const thought: StreamItem = {
    kind: "thought",
    id: "thought",
    text: "Checking",
    status: "ready",
    timestamp: new Date(0),
  };
  const single = project({ level: "overview", tail: [thought] });
  expect(single.tail).toEqual([thought]);
  expect(single.groupsByHostId.size).toBe(0);
  const grouped = project({
    level: "overview",
    tail: [thought, toolCall("1", { type: "shell", command: "one" })],
  });
  expect(grouped.tail.map((item) => item.id)).toEqual([thought.id]);
  expect(grouped.groupsByHostId.get(thought.id)?.run.calls).toHaveLength(2);
});
