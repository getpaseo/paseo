import { expect, it } from "vitest";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { buildAgentStreamRenderModel } from "./model";
import type { StreamItem } from "@/types/stream";

function revealHistory(tail: StreamItem[]): WeakRef<StreamItem[]>[] {
  const windows: WeakRef<StreamItem[]>[] = [];
  for (let start = tail.length - 20; start >= 20; start -= 20) {
    const model = buildAgentStreamRenderModel({
      tail,
      head: [],
      historyStart: start,
      platform: "web",
      isMobileBreakpoint: false,
      isTurnActive: false,
      activeTurnStartedAt: null,
    });
    windows.push(new WeakRef(model.history));
  }
  return windows;
}

it("releases obsolete history windows and their source timeline", async () => {
  setFlagsFromString("--expose_gc");
  const gc = runInNewContext("gc") as () => void;
  setFlagsFromString("--no-expose_gc");
  async function collect() {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
    }
  }
  let tail: StreamItem[] = Array.from({ length: 1000 }, (_, i) => ({
    kind: i % 2 ? "assistant_message" : "user_message",
    id: `row-${i}`,
    text: "text",
    timestamp: new Date(1700000000000 + i * 1000),
  }));
  const windows = revealHistory(tail);
  await collect();
  expect(windows.filter((ref) => ref.deref() !== undefined)).toHaveLength(1);

  windows.push(...revealHistory(tail));
  await collect();
  expect(windows.filter((ref) => ref.deref() !== undefined)).toHaveLength(1);

  tail = [];
  await collect();
  expect(windows.every((ref) => ref.deref() === undefined)).toBe(true);
});
