import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "./agent-sdk-types.js";
import { ResponseHeadingTitleTracker } from "./response-heading-title.js";

const agentId = "agent-1";
const turnId = "turn-1";

function assistant(text: string): AgentStreamEvent {
  return {
    type: "timeline",
    provider: "codex",
    turnId,
    item: { type: "assistant_message", text },
  };
}

function observe(tracker: ResponseHeadingTitleTracker, event: AgentStreamEvent): string | null {
  return tracker.observe({ agentId, turnId, event });
}

describe("ResponseHeadingTitleTracker", () => {
  test("extracts a valid fragmented H1 with LF or CRLF", () => {
    for (const newline of ["\n", "\r\n"]) {
      const tracker = new ResponseHeadingTitleTracker();
      expect(observe(tracker, assistant("# Paseo: naprawa "))).toBeNull();
      expect(observe(tracker, assistant(`synchronizacji tytułu sesji${newline}Treść`))).toBe(
        "Paseo: naprawa synchronizacji tytułu sesji",
      );
    }
  });

  test("accepts the exact word and character limits", () => {
    const fourWords = new ResponseHeadingTitleTracker();
    expect(observe(fourWords, assistant("# Paseo: jeden dwa trzy\n"))).toBe(
      "Paseo: jeden dwa trzy",
    );

    const sevenWords = new ResponseHeadingTitleTracker();
    expect(observe(sevenWords, assistant("# Paseo: jeden dwa trzy cztery pięć sześć\n"))).toBe(
      "Paseo: jeden dwa trzy cztery pięć sześć",
    );

    const sixtyCharacters = new ResponseHeadingTitleTracker();
    const exactTitle = `Paseo: jeden dwa trzy ${"x".repeat(38)}`;
    expect(exactTitle).toHaveLength(60);
    expect(observe(sixtyCharacters, assistant(`# ${exactTitle}\n`))).toBe(exactTitle);
  });

  test.each([
    ["second-level heading", "## Paseo: naprawa synchronizacji tytułu sesji\n"],
    ["text before H1", "Wstęp\n# Paseo: naprawa synchronizacji tytułu sesji\n"],
    ["empty title", "# \n"],
    ["too few words", "# Paseo: naprawa tytułu\n"],
    ["too many words", "# Paseo: jeden dwa trzy cztery pięć sześć siedem\n"],
    ["more than 60 characters", `# Paseo: jeden dwa trzy ${"x".repeat(39)}\n`],
  ])("rejects %s", (_name, text) => {
    const tracker = new ResponseHeadingTitleTracker();
    expect(observe(tracker, assistant(text))).toBeNull();
  });

  test("does not accept a later H1 after the response started without one", () => {
    const tracker = new ResponseHeadingTitleTracker();
    expect(observe(tracker, assistant("Zwykła odpowiedź."))).toBeNull();
    expect(
      observe(tracker, assistant("\n# Paseo: naprawa synchronizacji tytułu sesji\n")),
    ).toBeNull();
  });

  test("does not accept another H1 after the first heading was decided", () => {
    for (const firstHeading of [
      "# Paseo: naprawa synchronizacji tytułu sesji\n",
      "# Nagłówek bez nazwanego podmiotu\n",
    ]) {
      const tracker = new ResponseHeadingTitleTracker();
      observe(tracker, assistant(firstHeading));
      expect(
        observe(tracker, assistant("# Foundation: późniejsza zmiana tytułu sesji\n")),
      ).toBeNull();
    }
  });

  test("ignores history without a live turn id", () => {
    const tracker = new ResponseHeadingTitleTracker();
    expect(
      tracker.observe({
        agentId,
        turnId: undefined,
        event: assistant("# Paseo: naprawa synchronizacji tytułu sesji\n"),
      }),
    ).toBeNull();
  });

  test("finalizes a valid heading when a turn ends without a newline", () => {
    const tracker = new ResponseHeadingTitleTracker();
    expect(observe(tracker, assistant("# Paseo: naprawa synchronizacji tytułu sesji"))).toBeNull();
    expect(observe(tracker, { type: "turn_completed", provider: "codex", turnId })).toBe(
      "Paseo: naprawa synchronizacji tytułu sesji",
    );
  });
});
