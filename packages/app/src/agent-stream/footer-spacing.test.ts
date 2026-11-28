import { describe, expect, it } from "vitest";
import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import { layoutStream } from "./layout";
import type { StreamStrategy } from "./strategy";
import { resolveStreamRenderStrategy } from "./strategy-resolver";

function strategyFor(platform: "web" | "native"): StreamStrategy {
  return resolveStreamRenderStrategy({
    platform: platform === "native" ? "android" : "web",
    isMobileBreakpoint: false,
  });
}

function userMessage(id: string): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: new Date("2026-08-22T10:00:00.000Z"),
  };
}

function assistantMessage(id: string): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: new Date("2026-08-22T10:00:01.000Z"),
  };
}

function timingFor(assistantId: string): Map<string, TurnTiming> {
  return new Map([
    [
      assistantId,
      {
        completedAt: new Date("2026-08-22T10:00:02.000Z"),
        durationMs: 2_000,
      },
    ],
  ]);
}

function layoutFor(input: { platform: "web" | "native"; isTurnActive: boolean }) {
  const strategy = strategyFor(input.platform);
  const assistant = assistantMessage("assistant");
  return {
    assistant,
    layout: layoutStream({
      strategy,
      isTurnActive: input.isTurnActive,
      history: strategy.orderTail([userMessage("user"), assistant]),
      liveHead: [],
      timingByItemId: timingFor(assistant.id),
    }),
  };
}

describe("turn footer spacing", () => {
  it.each(["web", "native"] as const)(
    "compacts the last assistant against the completed footer on %s",
    (platform) => {
      const { assistant, layout } = layoutFor({ platform, isTurnActive: false });
      const assistantLayout = layout.history.find((item) => item.item.id === assistant.id);

      expect(layout.auxiliaryTurnFooter?.itemId).toBe(assistant.id);
      expect(assistantLayout?.assistantSpacing).toBe("compactBottom");
    },
  );

  it.each(["web", "native"] as const)(
    "keeps the same compact edge while the footer is running on %s",
    (platform) => {
      const { assistant, layout } = layoutFor({ platform, isTurnActive: true });
      const assistantLayout = layout.history.find((item) => item.item.id === assistant.id);

      expect(layout.auxiliaryTurnFooter).toBeNull();
      expect(assistantLayout?.assistantSpacing).toBe("compactBottom");
    },
  );
});
