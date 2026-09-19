import { describe, expect, it } from "vitest";
import { resolvePromptSuggestionView } from "./model";

const SUGGESTIONS = [
  { id: "s1", text: "run the failing test" },
  { id: "s2", text: "open a PR" },
  { id: "s3", text: "explain the diff" },
];

const GENERATED_AT = "2026-09-18T10:00:00.000Z";

const BASE = {
  suggestions: SUGGESTIONS,
  turnSeq: 4,
  generatedAt: GENERATED_AT,
  lastUserMessageAt: new Date("2026-09-18T09:59:30.000Z"),
  hasText: false,
  isAgentRunning: false,
  isReadOnly: false,
  dismissedTurnSeq: null,
};

describe("resolvePromptSuggestionView", () => {
  it("puts the first suggestion in the ghost and the rest in chips", () => {
    expect(resolvePromptSuggestionView(BASE)).toEqual({
      ghost: SUGGESTIONS[0],
      chips: [SUGGESTIONS[1], SUGGESTIONS[2]],
    });
  });

  it("shows nothing while the composer holds a draft", () => {
    expect(resolvePromptSuggestionView({ ...BASE, hasText: true })).toEqual({
      ghost: null,
      chips: [],
    });
  });

  it("shows nothing while the agent is running or the composer is read-only", () => {
    expect(resolvePromptSuggestionView({ ...BASE, isAgentRunning: true }).ghost).toBeNull();
    expect(resolvePromptSuggestionView({ ...BASE, isReadOnly: true }).ghost).toBeNull();
  });

  it("keeps the suggestion hidden once dismissed for this turn", () => {
    expect(resolvePromptSuggestionView({ ...BASE, dismissedTurnSeq: 4 }).ghost).toBeNull();
    expect(resolvePromptSuggestionView({ ...BASE, dismissedTurnSeq: 5 }).ghost).toBeNull();
  });

  it("returns a later turn's suggestion after an earlier dismissal", () => {
    expect(resolvePromptSuggestionView({ ...BASE, dismissedTurnSeq: 3 }).ghost).toEqual(
      SUGGESTIONS[0],
    );
  });

  it("handles an empty or missing payload", () => {
    expect(resolvePromptSuggestionView({ ...BASE, suggestions: [] }).ghost).toBeNull();
    expect(resolvePromptSuggestionView({ ...BASE, suggestions: undefined }).ghost).toBeNull();
    expect(resolvePromptSuggestionView({ ...BASE, turnSeq: undefined }).ghost).toBeNull();
  });

  it("drops a suggestion once a newer message has started another turn", () => {
    expect(
      resolvePromptSuggestionView({
        ...BASE,
        lastUserMessageAt: new Date("2026-09-18T10:00:30.000Z"),
      }).ghost,
    ).toBeNull();
  });

  it("keeps a suggestion for an agent that has no recorded message", () => {
    expect(resolvePromptSuggestionView({ ...BASE, lastUserMessageAt: null }).ghost).toEqual(
      SUGGESTIONS[0],
    );
    expect(resolvePromptSuggestionView({ ...BASE, lastUserMessageAt: undefined }).ghost).toEqual(
      SUGGESTIONS[0],
    );
  });

  it("gives one suggestion a ghost and no chips", () => {
    expect(resolvePromptSuggestionView({ ...BASE, suggestions: [SUGGESTIONS[0]] })).toEqual({
      ghost: SUGGESTIONS[0],
      chips: [],
    });
  });
});
