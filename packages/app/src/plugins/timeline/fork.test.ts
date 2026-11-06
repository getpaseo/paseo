import { describe, expect, it } from "vitest";
import type { PluginTimelineStreamItem } from "@/types/stream";
import type { AssistantTurnForkHandler } from "@/agent-stream/turn-footer";
import { projectPluginTimelineItems } from "./projection";
import { resolvePluginTimelineFork } from "./fork";

const source = {
  kind: "assistant_message" as const,
  id: "source-reply",
  messageId: "provider-reply",
  text: "Original reply",
  timestamp: new Date("2026-01-01T00:00:00Z"),
  timelineCursor: { epoch: "history-1", seq: 42 },
};

function project(phase: "streaming" | "complete" = "complete"): PluginTimelineStreamItem[] {
  const items = projectPluginTimelineItems(
    [source],
    () =>
      [0, 1].map((index) => ({
        type: "plugin" as const,
        id: `part-${index}`,
        pluginId: "markdown",
        kind: "reply",
        version: 1,
        data: { text: "Modified text", boundaryMessageId: "untrusted" },
      })),
    phase,
  );
  return items.filter((item): item is PluginTimelineStreamItem => item.kind === "plugin");
}

describe("plugin timeline fork", () => {
  it.each(["tab", "workspace"] as const)(
    "forks an exploded row into %s using the original boundary",
    async (target) => {
      const requests: Parameters<AssistantTurnForkHandler>[0][] = [];
      for (const item of project()) {
        const fork = resolvePluginTimelineFork({
          item,
          supportsTimelineCursor: true,
          onForkAssistantTurn: (request) => {
            requests.push(request);
          },
        });
        expect(fork).not.toBeNull();
        await fork?.(target);
      }
      expect(requests).toEqual(
        [0, 1].map(() => ({
          target,
          boundary: { boundaryCursor: source.timelineCursor, boundaryMessageId: source.messageId },
        })),
      );
    },
  );

  it("uses only the provider message ID on hosts without cursor support", async () => {
    const requests: Parameters<AssistantTurnForkHandler>[0][] = [];
    const fork = resolvePluginTimelineFork({
      item: project()[0],
      supportsTimelineCursor: false,
      onForkAssistantTurn: (request) => {
        requests.push(request);
      },
    });
    await fork?.("tab");
    expect(requests).toEqual([
      { target: "tab", boundary: { boundaryMessageId: source.messageId } },
    ]);
  });

  it("offers no action in read-only views, streaming rows, or daemon-pushed rows", () => {
    const onForkAssistantTurn = () => {
      throw new Error("must not fork");
    };
    expect(
      resolvePluginTimelineFork({ item: project()[0], supportsTimelineCursor: true }),
    ).toBeNull();
    expect(
      resolvePluginTimelineFork({
        item: project("streaming")[0],
        supportsTimelineCursor: true,
        onForkAssistantTurn,
      }),
    ).toBeNull();
    const { sourceAssistant: _sourceAssistant, ...pushed } = project()[0];
    expect(
      resolvePluginTimelineFork({
        item: pushed,
        supportsTimelineCursor: true,
        onForkAssistantTurn,
      }),
    ).toBeNull();
  });

  it("supports cursor-only replies and refuses unbounded forks", async () => {
    const requests: Parameters<AssistantTurnForkHandler>[0][] = [];
    const item = { ...project()[0], sourceAssistant: {} };
    const onForkAssistantTurn: AssistantTurnForkHandler = (request) => {
      requests.push(request);
    };
    const fork = resolvePluginTimelineFork({
      item,
      supportsTimelineCursor: true,
      onForkAssistantTurn,
    });
    await fork?.("workspace");
    expect(requests).toEqual([
      { target: "workspace", boundary: { boundaryCursor: source.timelineCursor } },
    ]);
    expect(
      resolvePluginTimelineFork({ item, supportsTimelineCursor: false, onForkAssistantTurn }),
    ).toBeNull();
  });

  it("does not make transformed non-assistant rows forkable", () => {
    const [item] = projectPluginTimelineItems(
      [
        {
          kind: "thought",
          id: "thought",
          text: "Reasoning",
          timestamp: source.timestamp,
          status: "ready",
          timelineCursor: source.timelineCursor,
        },
      ],
      () => [
        {
          type: "plugin",
          id: "thought",
          pluginId: "markdown",
          kind: "thought",
          version: 1,
          data: {},
        },
      ],
    );
    expect(item).not.toHaveProperty("sourceAssistant");
  });

  it("preserves fork failures for the host menu to settle its pending state", async () => {
    const error = new Error("host disconnected");
    const fork = resolvePluginTimelineFork({
      item: project()[0],
      supportsTimelineCursor: true,
      onForkAssistantTurn: async () => {
        throw error;
      },
    });
    await expect(fork?.("tab")).rejects.toBe(error);
  });
});
