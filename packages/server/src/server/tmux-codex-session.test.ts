import { describe, expect, it, vi } from "vitest";

import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import { createTmuxCodexSession } from "./tmux-codex-session.js";

describe("tmux codex session", () => {
  it("captures initial output and forwards follow-up input through tmux", async () => {
    const sendKeys = vi.fn(async () => undefined);
    const capturePane = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first line\nsecond line")
      .mockResolvedValueOnce("first line\nsecond line")
      .mockResolvedValue("first line\nsecond line\nthird line");
    const isProcessAlive = vi.fn(async () => true);

    const session = createTmuxCodexSession({
      sessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
      paneId: "%12",
      cwd: "/workspace/project",
      title: "project",
      capturePane,
      sendKeys,
      isProcessAlive,
      pollIntervalMs: 10_000,
      settleDelayMs: 500,
    });

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      history.push(event);
    }
    expect(history).toEqual([
      {
        type: "thread_started",
        provider: "codex",
        sessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
      },
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          text: "first line\nsecond line",
        },
      },
    ]);

    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
    });

    const turn = await session.startTurn("continue from here");
    expect(turn.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sendKeys).toHaveBeenCalledWith("%12", ["continue from here", "Enter"]);

    await session.pollNow();
    expect(events).toContainEqual({
      type: "timeline",
      provider: "codex",
      turnId: turn.turnId,
      item: {
        type: "assistant_message",
        text: "third line",
      },
    });

    await session.interrupt();
    expect(sendKeys).toHaveBeenLastCalledWith("%12", ["C-c"]);

    unsubscribe();
    await session.close();
  });

  it("treats a missing tmux pane as empty output instead of rejecting", async () => {
    const capturePane = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new Error("Command failed: tmux capture-pane -p -J -S -200 -t %12\ncan't find pane: %12\n"),
      )
      .mockRejectedValueOnce(
        new Error("Command failed: tmux capture-pane -p -J -S -200 -t %12\ncan't find pane: %12\n"),
      );
    const session = createTmuxCodexSession({
      sessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
      paneId: "%12",
      cwd: "/workspace/project",
      title: "project",
      capturePane,
      sendKeys: vi.fn(async () => undefined),
      isProcessAlive: vi.fn(async () => false),
      pollIntervalMs: 10_000,
      settleDelayMs: 500,
    });

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      history.push(event);
    }
    expect(history).toEqual([]);

    await expect(session.pollNow()).resolves.toBeUndefined();
    await session.close();
  });
});
