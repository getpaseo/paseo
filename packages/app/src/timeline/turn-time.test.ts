import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { deriveStreamTurnTiming } from "./turn-time";
import type { StreamItem } from "@/types/stream";

function user(id: string, timestamp: Date): StreamItem {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp,
  };
}

function assistant(id: string, timestamp: Date, text = id): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp,
  };
}

describe("deriveStreamTurnTiming", () => {
  it("starts elapsed time from the submitted prompt", () => {
    const submittedAt = new Date("2026-05-15T00:00:00.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: submittedAt,
      tail: [],
      head: [user("submitted", submittedAt)],
    });

    assert.equal(timing.runningStartedAt, submittedAt);
  });

  it("uses the last user message as the running turn start", () => {
    const firstUserAt = new Date("2026-05-15T00:00:00.000Z");
    const secondUserAt = new Date("2026-05-15T00:01:00.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: secondUserAt,
      tail: [
        user("u1", firstUserAt),
        assistant("a1", new Date("2026-05-15T00:00:05.000Z")),
        user("u2", secondUserAt),
      ],
      head: [assistant("a2", new Date("2026-05-15T00:01:04.000Z"))],
    });

    assert.equal(timing.runningStartedAt, secondUserAt);
    assert.equal(timing.byAssistantId.has("a2"), false);
  });

  it("derives completed turn timing from user and assistant item timestamps", () => {
    const userAt = new Date("2026-05-15T00:00:00.000Z");
    const assistantAt = new Date("2026-05-15T00:00:07.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        user("u1", userAt),
        assistant("a1", assistantAt),
        user("u2", new Date("2026-05-15T00:01:00.000Z")),
      ],
      head: [],
    });

    assert.deepEqual(timing.byAssistantId.get("a1"), {
      completedAt: assistantAt,
      durationMs: 7000,
    });
  });

  it("maps multiple assistant chunks in one turn to the same timing", () => {
    const userAt = new Date("2026-05-15T00:00:00.000Z");
    const firstAssistantAt = new Date("2026-05-15T00:00:03.000Z");
    const lastAssistantAt = new Date("2026-05-15T00:00:07.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        user("u1", userAt),
        assistant("a1", firstAssistantAt),
        assistant("a2", lastAssistantAt),
      ],
      head: [],
    });

    const expected = {
      completedAt: lastAssistantAt,
      durationMs: 7000,
    };
    assert.deepEqual(timing.byAssistantId.get("a1"), expected);
    assert.deepEqual(timing.byAssistantId.get("a2"), expected);
  });

  it("preserves the completion timestamp when a canonical turn has no visible prompt", () => {
    const firstTurnAt = new Date("2026-05-15T00:00:00.000Z");
    const hiddenPromptTurnAt = new Date("2026-05-15T00:01:07.000Z");
    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        { ...user("u1", firstTurnAt), turnId: "turn-1" },
        {
          ...assistant("a1", new Date("2026-05-15T00:00:07.000Z")),
          turnId: "turn-1",
        },
        {
          ...assistant("hidden-prompt-a1", new Date("2026-05-15T00:01:03.000Z")),
          turnId: "turn-2",
        },
        { ...assistant("hidden-prompt-a2", hiddenPromptTurnAt), turnId: "turn-2" },
      ],
      head: [],
    });

    assert.deepEqual(timing.byAssistantId.get("hidden-prompt-a2"), {
      completedAt: hiddenPromptTurnAt,
      durationMs: null,
    });
  });

  it("keeps the timing map identity while a streamed delta grows the live head", () => {
    const tail = [
      user("u1", new Date("2026-05-15T00:00:00.000Z")),
      assistant("a1", new Date("2026-05-15T00:00:07.000Z")),
      user("u2", new Date("2026-05-15T00:01:00.000Z")),
    ];
    const derive = (text: string, at: string) =>
      deriveStreamTurnTiming({
        isTurnActive: true,
        activeTurnStartedAt: tail[2]?.timestamp ?? null,
        tail,
        head: [assistant("a2", new Date(at), text)],
      });

    const first = derive("one", "2026-05-15T00:01:04.000Z");
    const second = derive("one two", "2026-05-15T00:01:05.000Z");

    assert.equal(second.byAssistantId, first.byAssistantId);
    assert.deepEqual(first.byAssistantId.get("a1"), {
      completedAt: tail[1]?.timestamp,
      durationMs: 7000,
    });
    assert.equal(first.byAssistantId.has("a2"), false);
  });

  it("keeps the timing map identity when the head closed the tail's open turn", () => {
    const lastTailAt = new Date("2026-05-15T00:00:07.000Z");
    const tail = [user("u1", new Date("2026-05-15T00:00:00.000Z")), assistant("a1", lastTailAt)];
    const derive = (text: string, at: string) =>
      deriveStreamTurnTiming({
        isTurnActive: true,
        activeTurnStartedAt: null,
        tail,
        head: [
          user("u2", new Date("2026-05-15T00:01:00.000Z")),
          assistant("a2", new Date(at), text),
        ],
      });

    const first = derive("one", "2026-05-15T00:01:04.000Z");
    const second = derive("one two", "2026-05-15T00:01:05.000Z");

    assert.equal(second.byAssistantId, first.byAssistantId);
    assert.deepEqual(first.byAssistantId.get("a1"), {
      completedAt: lastTailAt,
      durationMs: 7000,
    });
  });

  it("produces a new timing map when the streamed turn completes", () => {
    const tail = [user("u1", new Date("2026-05-15T00:00:00.000Z"))];
    const completedAt = new Date("2026-05-15T00:00:09.000Z");
    const head = [assistant("a1", completedAt)];

    const active = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head,
    });
    const completed = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head,
    });

    assert.notEqual(completed.byAssistantId, active.byAssistantId);
    assert.equal(active.byAssistantId.has("a1"), false);
    assert.deepEqual(completed.byAssistantId.get("a1"), { completedAt, durationMs: 9000 });
  });

  it("derives fresh timing when the tail itself changes", () => {
    const firstTail = [
      user("u1", new Date("2026-05-15T00:00:00.000Z")),
      assistant("a1", new Date("2026-05-15T00:00:07.000Z")),
      user("u2", new Date("2026-05-15T00:01:00.000Z")),
    ];
    const secondTail = [...firstTail, assistant("a2", new Date("2026-05-15T00:01:03.000Z"))];
    const derive = (tail: StreamItem[]) =>
      deriveStreamTurnTiming({ isTurnActive: false, activeTurnStartedAt: null, tail, head: [] });

    const first = derive(firstTail);
    const second = derive(secondTail);

    assert.notEqual(second.byAssistantId, first.byAssistantId);
    assert.equal(first.byAssistantId.has("a2"), false);
    assert.deepEqual(second.byAssistantId.get("a2"), {
      completedAt: secondTail[3]?.timestamp,
      durationMs: 3000,
    });
  });
});
