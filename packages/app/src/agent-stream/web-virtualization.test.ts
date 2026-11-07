import { describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import {
  setAssistantMessageHeight,
  clearAssistantMessageHeightEstimateCache,
} from "@/utils/assistant-message-height-estimate";
import {
  DEFAULT_WEB_MOUNTED_RECENT_STREAM_ITEMS,
  DEFAULT_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD,
  estimateStreamItemHeight,
  findMountedWindowStart,
  getWebMountedRecentStreamItems,
  getWebPartialVirtualizationThreshold,
  splitWebVirtualizedHistory,
  type IndexedStreamItem,
} from "./web-virtualization";

function createTimestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, seed: number): StreamItem {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

function assistantMessage(id: string, seed: number): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

function toolCall(id: string, seed: number): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: createTimestamp(seed),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "test_tool",
        arguments: {},
        status: "completed",
      },
    },
  };
}

function thought(id: string, seed: number): StreamItem {
  return {
    kind: "thought",
    id,
    text: id,
    status: "ready",
    timestamp: createTimestamp(seed),
  };
}

function indexEntries(items: StreamItem[]): IndexedStreamItem[] {
  return items.map((item, index) => ({ item, index }));
}

describe("findMountedWindowStart", () => {
  it("mounts complete autonomous runs and keeps same-run steers together", () => {
    const items = [
      { ...userMessage("human", 1), turnId: "first" },
      { ...assistantMessage("reply", 2), turnId: "first" },
      { ...toolCall("wake", 3), turnId: "autonomous" },
      { ...userMessage("steer", 4), turnId: "autonomous" },
      { ...assistantMessage("done", 5), turnId: "autonomous" },
    ];
    expect(findMountedWindowStart({ items, minMountedCount: 1 })).toBe(2);
  });

  it("keeps all items mounted when the chat is below the threshold", () => {
    const items = [userMessage("u1", 1), assistantMessage("a1", 2)];

    expect(
      findMountedWindowStart({
        items,
        minMountedCount: 50,
      }),
    ).toBe(0);
  });

  it("rewinds to the previous user boundary when the cutoff lands inside a turn", () => {
    const items: StreamItem[] = [];
    for (let index = 0; index < 30; index += 1) {
      const seed = index * 3;
      items.push(userMessage(`u${index}`, seed + 1));
      items.push(toolCall(`t${index}`, seed + 2));
      items.push(assistantMessage(`a${index}`, seed + 3));
    }

    expect(
      findMountedWindowStart({
        items,
        minMountedCount: 50,
      }),
    ).toBe(39);
  });
});

describe("splitWebVirtualizedHistory", () => {
  it("splits older entries into the virtualized section and keeps the recent window mounted", () => {
    const items: StreamItem[] = [];
    for (let index = 0; index < 30; index += 1) {
      const seed = index * 2;
      items.push(userMessage(`u${index}`, seed + 1));
      items.push(assistantMessage(`a${index}`, seed + 2));
    }

    const window = splitWebVirtualizedHistory({
      entries: indexEntries(items),
      minMountedCount: 50,
    });

    expect(window.virtualizedEntries).toHaveLength(10);
    expect(window.virtualizedEntries[0]?.item.id).toBe("u0");
    expect(window.virtualizedEntries.at(-1)?.item.id).toBe("a4");
    expect(window.mountedEntries[0]?.item.id).toBe("u5");
    expect(window.mountedEntries).toHaveLength(50);
  });
});

describe("estimateStreamItemHeight", () => {
  it("uses compact estimates for collapsed tool sequence rows", () => {
    expect(
      estimateStreamItemHeight({
        item: toolCall("tool", 1),
        contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
      }),
    ).toBe(40);
    expect(
      estimateStreamItemHeight({
        item: thought("thought", 2),
        contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
      }),
    ).toBe(40);
  });

  it("uses a larger estimate for user messages with image attachments", () => {
    const item: StreamItem = {
      kind: "user_message",
      id: "u-image",
      text: "image",
      timestamp: createTimestamp(1),
      images: [
        {
          id: "att-1",
          mimeType: "image/png",
          storageType: "desktop-file",
          storageKey: "/tmp/screenshot.png",
          fileName: "screenshot.png",
          byteSize: 1024,
          createdAt: Date.now(),
        },
      ],
    };

    expect(estimateStreamItemHeight({ item, contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH })).toBe(
      220,
    );
  });

  it("uses the renderer's whole-message measurement at the measured width", () => {
    clearAssistantMessageHeightEstimateCache();
    const item: StreamItem = {
      kind: "assistant_message",
      id: "measured",
      text: "First paragraph\n\n![Image](image.png)",
      timestamp: createTimestamp(2),
    };
    setAssistantMessageHeight({ markdown: item.text, width: 608, height: 640 });
    expect(estimateStreamItemHeight({ item, contentMaxWidth: 608 })).toBe(640);
    expect(estimateStreamItemHeight({ item, contentMaxWidth: 320 })).toBe(220);
    clearAssistantMessageHeightEstimateCache();
  });
});

describe("web virtualization test overrides", () => {
  it("uses defaults unless explicit positive integer overrides are present", () => {
    const globalWithOverrides = globalThis as typeof globalThis & {
      __PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD?: unknown;
      __PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS?: unknown;
    };
    const previousThreshold = globalWithOverrides.__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD;
    const previousMounted = globalWithOverrides.__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS;

    try {
      delete globalWithOverrides.__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD;
      delete globalWithOverrides.__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS;
      expect(getWebPartialVirtualizationThreshold()).toBe(
        DEFAULT_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD,
      );
      expect(getWebMountedRecentStreamItems()).toBe(DEFAULT_WEB_MOUNTED_RECENT_STREAM_ITEMS);

      globalWithOverrides.__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD = 6;
      globalWithOverrides.__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS = 4;
      expect(getWebPartialVirtualizationThreshold()).toBe(6);
      expect(getWebMountedRecentStreamItems()).toBe(4);
    } finally {
      if (previousThreshold === undefined) {
        delete globalWithOverrides.__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD;
      } else {
        globalWithOverrides.__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD = previousThreshold;
      }
      if (previousMounted === undefined) {
        delete globalWithOverrides.__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS;
      } else {
        globalWithOverrides.__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS = previousMounted;
      }
    }
  });
});
