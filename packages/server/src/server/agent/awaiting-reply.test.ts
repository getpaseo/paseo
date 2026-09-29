import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { endsWithQuestionToUser } from "./awaiting-reply.js";

const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });
const agent = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });

describe("endsWithQuestionToUser", () => {
  it("is true when the agent's last line asks something, markdown and all", () => {
    expect(
      endsWithQuestionToUser([user("fix it"), agent("Done.\n\n**Soll ich das auch deployen?**")]),
    ).toBe(true);
    expect(endsWithQuestionToUser([user("fix it"), agent("Which one: A or B？")])).toBe(true);
  });

  it("is false once the person has answered, or when the agent only reports", () => {
    expect(endsWithQuestionToUser([agent("Soll ich deployen?"), user("ja")])).toBe(false);
    expect(
      endsWithQuestionToUser([user("fix it"), agent("Is it fixed? Yes, all tests pass.")]),
    ).toBe(false);
    expect(endsWithQuestionToUser([])).toBe(false);
  });
});
