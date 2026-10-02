import { describe, expect, test } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { buildAgentHandoffNote } from "./handoff.js";

function note(timeline: AgentTimelineItem[], overrides?: { interrupted?: boolean }): string {
  return buildAgentHandoffNote({
    title: "Fix the flaky upload test",
    cwd: "/repo/app",
    previous: { provider: "claude", model: "opus" },
    next: { provider: "codex", model: "gpt-5" },
    timeline,
    interrupted: overrides?.interrupted,
  });
}

describe("buildAgentHandoffNote", () => {
  test("says who it was, who it is now, and what the task is", () => {
    const text = note([]);
    expect(text).toContain("claude (opus)");
    expect(text).toContain("codex (gpt-5)");
    expect(text).toContain("Fix the flaky upload test");
    expect(text).toContain("/repo/app");
  });

  test("carries the person's own last instructions, oldest first", () => {
    const text = note([
      { type: "user_message", text: "start with the upload test" },
      { type: "assistant_message", text: "looking" },
      { type: "user_message", text: "only the retry path" },
    ]);
    expect(text.indexOf("start with the upload test")).toBeLessThan(
      text.indexOf("only the retry path"),
    );
  });

  test("leaves Paseo's own injected envelopes out of what the person asked for", () => {
    const text = note([
      { type: "user_message", text: "<paseo-system>\nscheduled run\n</paseo-system>" },
      { type: "user_message", text: "only the retry path" },
    ]);
    expect(text).not.toContain("scheduled run");
    expect(text).toContain("only the retry path");
  });

  test("quotes only the last few instructions, so the note cannot grow with the session", () => {
    const text = note([
      { type: "user_message", text: "first thing" },
      { type: "user_message", text: "second thing" },
      { type: "user_message", text: "third thing" },
      { type: "user_message", text: "fourth thing" },
    ]);
    // The activity summary below may still mention older turns; this is about
    // the section that quotes the person.
    const quoted = text.slice(
      text.indexOf("What the person asked for"),
      text.indexOf("What has been done so far"),
    );
    expect(quoted).not.toContain("first thing");
    expect(quoted).toContain("second thing");
    expect(quoted).toContain("fourth thing");
  });

  test("reports where the previous session left off", () => {
    const text = note([{ type: "assistant_message", text: "patched the retry, tests still red" }]);
    expect(text).toContain("patched the retry, tests still red");
  });

  test("warns when the switch cut a turn in half", () => {
    expect(note([], { interrupted: true })).toContain("cut off by the switch");
    expect(note([])).not.toContain("cut off by the switch");
  });

  test("stays bounded no matter how long the conversation was", () => {
    const timeline: AgentTimelineItem[] = [];
    for (let index = 0; index < 40; index += 1) {
      timeline.push({ type: "user_message", text: `ask ${index} ${"x".repeat(2000)}` });
      timeline.push({ type: "assistant_message", text: `answer ${index} ${"y".repeat(2000)}` });
    }
    const text = note(timeline);
    expect(text).toContain("…");
    // Every section is capped, so the whole note is: roughly a page, not a transcript.
    expect(text.length).toBeLessThan(3000);
  });
});

test("interrupted provider handoff carries completed tool result data", () => {
  const text = note(
    [
      { type: "user_message", text: "Write once" },
      {
        type: "tool_call",
        callId: "write",
        name: "write",
        status: "completed",
        error: null,
        detail: { type: "write", filePath: "/result", content: "recorded-write-result" },
      },
    ],
    { interrupted: true },
  );
  expect(text).toContain("Recorded tool checkpoints");
  expect(text).toContain("recorded-write-result");
  expect(text).toContain("do not repeat completed side effects");
});
