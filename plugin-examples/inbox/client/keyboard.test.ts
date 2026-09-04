import { describe, expect, it } from "vitest";
import { keyToAction, optionResponse, permissionResponse, resolveKeyAction } from "./keyboard";
import type { InboxCard } from "./lanes";

function card(input: Partial<InboxCard>): InboxCard {
  return {
    agent: { id: "a" },
    workspace: null,
    lane: "needsYou",
    reason: "question",
    request: null,
    requestAgentId: "a",
    subagentCount: 0,
    since: null,
    ...input,
  } as InboxCard;
}

describe("keyToAction", () => {
  it("maps plain keys and ignores modifiers", () => {
    expect(keyToAction({ key: "j", metaKey: false, ctrlKey: false, altKey: false })).toEqual({
      kind: "move",
      delta: 1,
    });
    expect(keyToAction({ key: "3", metaKey: false, ctrlKey: false, altKey: false })).toEqual({
      kind: "option",
      index: 2,
    });
    expect(keyToAction({ key: "k", metaKey: true, ctrlKey: false, altKey: false })).toBeNull();
    expect(keyToAction({ key: "x", metaKey: false, ctrlKey: false, altKey: false })).toBeNull();
  });
});

describe("optionResponse", () => {
  const request = {
    id: "p",
    kind: "question",
    input: {
      questions: [
        { question: "Which?", header: "Lane", options: [{ label: "A" }, { label: "B" }] },
      ],
    },
  } as unknown as InboxCard["request"];

  it("answers a single-select single question by option index", () => {
    expect(optionResponse(card({ request }), 1)).toEqual({
      behavior: "allow",
      updatedInput: { ...request!.input, answers: { Lane: "B" } },
    });
  });

  it("refuses when the digit has no option or the question is multi-select", () => {
    expect(optionResponse(card({ request }), 5)).toBeNull();
    const multi = {
      ...request!,
      input: {
        questions: [
          { question: "Which?", header: "Lane", options: [{ label: "A" }], multiSelect: true },
        ],
      },
    } as unknown as InboxCard["request"];
    expect(optionResponse(card({ request: multi }), 0)).toBeNull();
  });
});

describe("permissionResponse", () => {
  it("uses the request's own actions when present", () => {
    const request = {
      id: "p",
      kind: "tool",
      actions: [
        { id: "ok", label: "Allow", behavior: "allow" },
        { id: "no", label: "Deny", behavior: "deny" },
      ],
    } as unknown as InboxCard["request"];
    expect(permissionResponse(card({ reason: "permission", request }), "allow")).toEqual({
      behavior: "allow",
      selectedActionId: "ok",
    });
    expect(permissionResponse(card({ reason: "permission", request }), "deny")).toMatchObject({
      behavior: "deny",
      selectedActionId: "no",
    });
    expect(permissionResponse(card({ reason: "question", request }), "allow")).toBeNull();
  });
});

describe("resolveKeyAction", () => {
  const ordered = [card({ agent: { id: "a" } } as never), card({ agent: { id: "b" } } as never)];

  it("moves focus with wraparound and starts from the ends", () => {
    expect(
      resolveKeyAction({ kind: "move", delta: 1 }, { ordered, focusedId: null, openCardId: null }),
    ).toEqual({ kind: "focus", agentId: "a" });
    expect(
      resolveKeyAction({ kind: "move", delta: -1 }, { ordered, focusedId: null, openCardId: null }),
    ).toEqual({ kind: "focus", agentId: "b" });
    expect(
      resolveKeyAction({ kind: "move", delta: 1 }, { ordered, focusedId: "b", openCardId: null }),
    ).toEqual({ kind: "focus", agentId: "a" });
  });

  it("opens the focused card or the first one, and Escape closes before it unfocuses", () => {
    expect(
      resolveKeyAction({ kind: "open" }, { ordered, focusedId: null, openCardId: null }),
    ).toEqual({ kind: "open", agentId: "a" });
    expect(
      resolveKeyAction({ kind: "close" }, { ordered, focusedId: "a", openCardId: "a" }),
    ).toEqual({ kind: "close" });
    expect(
      resolveKeyAction({ kind: "close" }, { ordered, focusedId: "a", openCardId: null }),
    ).toEqual({ kind: "focus", agentId: null });
  });
});

describe("resolveKeyAction respond", () => {
  const request = { id: "p", kind: "tool", actions: [] } as unknown as InboxCard["request"];
  const ordered = [
    card({ agent: { id: "a" }, reason: "permission", request } as never),
    card({ agent: { id: "b" } } as never),
  ];

  it("moves focus to the next card after answering", () => {
    const effect = resolveKeyAction(
      { kind: "allow" },
      { ordered, focusedId: "a", openCardId: null },
    );
    expect(effect).toMatchObject({ kind: "respond", nextFocusAgentId: "b" });
  });
});
