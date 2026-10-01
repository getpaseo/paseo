import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import { en } from "@/i18n/resources/en";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import type { TurnPresentation } from "@/timeline/turn-liveness";
import { buildWorkingLabel, resolveWorkingTool } from "./working-status";

const startedAt = new Date("2026-09-30T12:00:00Z");
const turn: TurnPresentation = {
  isActive: true,
  isCancelling: false,
  startedAt,
  turnId: "current",
};
const tool = {
  kind: "tool_call",
  id: "tool",
  turnId: "current",
  timestamp: startedAt,
  payload: {
    source: "agent",
    data: {
      provider: "claude",
      callId: "tool",
      name: "browser_test",
      status: "running",
      error: null,
      detail: { type: "unknown", input: null, output: null },
    },
  },
} satisfies ToolCallItem;

describe("working footer activity", () => {
  it("distinguishes working, delegation, permission and cancellation with real translations", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    const t = i18n.getFixedT("en");
    expect(buildWorkingLabel(t, turn, false, "Browser", 2)).toBe(
      "Working · Browser · Subagents: 2 working",
    );
    expect(buildWorkingLabel(t, { ...turn, isActive: false }, false, null, 1)).toBe(
      "Subagents: 1 working",
    );
    expect(buildWorkingLabel(t, turn, true, "Browser", 1)).toBe(
      "Needs input · Subagents: 1 working",
    );
    expect(buildWorkingLabel(t, { ...turn, isCancelling: true }, false, "Browser", 0)).toBe(
      "Canceling agent",
    );
    expect(buildWorkingLabel(t, { ...turn, isActive: false }, false, null, 0)).toBe("");
  });
  it("shows the live tool even while a message streams after it", () => {
    const message: StreamItem = {
      kind: "assistant_message",
      id: "reply",
      text: "Still working",
      timestamp: startedAt,
    };
    expect(resolveWorkingTool([tool, message], turn)).toBe("browser_test");
    const steer: StreamItem = {
      kind: "user_message",
      id: "steer",
      turnId: "current",
      text: "Also check this",
      timestamp: startedAt,
    };
    expect(resolveWorkingTool([tool, steer], turn)).toBe("browser_test");
    expect(resolveWorkingTool([tool], { ...turn, isActive: false })).toBeNull();
    expect(resolveWorkingTool([tool], { ...turn, isCancelling: true })).toBeNull();
  });

  it("never resurrects an unfinished tool from a previous turn", () => {
    expect(resolveWorkingTool([{ ...tool, turnId: "previous" }], turn)).toBeNull();
    expect(
      resolveWorkingTool([{ ...tool, turnId: undefined, timestamp: new Date(0) }], turn),
    ).toBeNull();
    const prompt: StreamItem = {
      kind: "user_message",
      id: "prompt",
      text: "Next",
      timestamp: startedAt,
    };
    expect(
      resolveWorkingTool([tool, prompt], { ...turn, turnId: null, startedAt: null }),
    ).toBeNull();
  });

  it("clears completed tools and supports orchestrator activity", () => {
    const completed: ToolCallItem = {
      ...tool,
      payload: {
        source: "agent",
        data: { ...tool.payload.data, status: "completed" },
      },
    };
    expect(resolveWorkingTool([completed], turn)).toBeNull();
    expect(
      resolveWorkingTool(
        [
          {
            ...tool,
            payload: {
              source: "orchestrator",
              data: {
                toolCallId: "tool",
                toolName: "Browser",
                arguments: {},
                status: "executing",
              },
            },
          },
        ],
        turn,
      ),
    ).toBe("Browser");
  });
});
