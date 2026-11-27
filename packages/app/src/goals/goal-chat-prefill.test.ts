import { describe, expect, it } from "vitest";
import { createUserMessage, type StreamItem } from "@/types/stream";
import {
  buildGoalPrefillFromChat,
  deriveGoalTitle,
  findLastUserMessageText,
} from "./goal-chat-prefill";

const at = new Date("2026-10-01T00:00:00.000Z");

function user(id: string, text: string): StreamItem {
  return createUserMessage({ id, text, timestamp: at });
}

function assistant(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: at };
}

const agent = { id: "agent-1", provider: "claude", cwd: "/repo" };

describe("deriveGoalTitle", () => {
  it("uses the first non-blank line", () => {
    expect(deriveGoalTitle("\n  Fix the login bug  \nIt fails on Safari")).toBe(
      "Fix the login bug",
    );
  });

  it("keeps a 60 character line and cuts a longer one with an ellipsis", () => {
    const sixty = "a".repeat(60);
    expect(deriveGoalTitle(sixty)).toBe(sixty);
    // 59 characters of "word word …" and the ellipsis.
    expect(deriveGoalTitle(`${"word ".repeat(20)}end`)).toBe(`${"word ".repeat(11)}word…`);
    // A cut that lands after a space does not keep it before the ellipsis.
    expect(deriveGoalTitle(`${"a".repeat(58)} ${"b".repeat(10)}`)).toBe(`${"a".repeat(58)}…`);
    expect(Array.from(deriveGoalTitle("b".repeat(80)))).toHaveLength(60);
  });

  it("is empty for blank text", () => {
    expect(deriveGoalTitle("  \n ")).toBe("");
  });
});

describe("findLastUserMessageText", () => {
  it("prefers the newest list and the last user message in it", () => {
    expect(
      findLastUserMessageText([
        [user("h1", "live prompt"), assistant("h2", "working")],
        [user("t1", "older prompt")],
      ]),
    ).toBe("live prompt");
  });

  it("falls back to older lists and skips blank messages", () => {
    expect(
      findLastUserMessageText([
        [user("h1", "   ")],
        [user("t1", " first "), assistant("t2", "ok")],
      ]),
    ).toBe("first");
  });

  it("is empty when the chat has no user message", () => {
    expect(findLastUserMessageText([[assistant("a", "hi")], []])).toBe("");
  });
});

describe("buildGoalPrefillFromChat", () => {
  it("uses the text after /goal as the objective", () => {
    expect(
      buildGoalPrefillFromChat({
        agent,
        args: " Add rate limiting\nper key ",
        lastUserMessage: "unrelated",
      }),
    ).toEqual({
      title: "Add rate limiting",
      objective: "Add rate limiting\nper key",
      managed: true,
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "claude",
      originAgentId: "agent-1",
    });
  });

  it("falls back to the last user message without arguments", () => {
    expect(
      buildGoalPrefillFromChat({ agent, args: "  ", lastUserMessage: "Fix the flaky test" }),
    ).toMatchObject({ title: "Fix the flaky test", objective: "Fix the flaky test" });
    expect(buildGoalPrefillFromChat({ agent, lastUserMessage: "" })).toMatchObject({
      title: "",
      objective: "",
      managed: true,
    });
  });
});
