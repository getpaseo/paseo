import { describe, expect, test } from "vitest";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";
import { resolveQuestionAnswers } from "./question-answers.js";

const request: AgentPermissionRequest = {
  id: "question-1",
  provider: "codex",
  name: "request_user_input",
  kind: "question",
  input: {
    questions: [
      {
        question: "Which colors?",
        header: "Colors",
        options: [{ label: "Red, bright" }, { label: "Blue" }],
        multiSelect: true,
        allowOther: true,
      },
      {
        question: "Which snack?",
        header: "Snack",
        options: [{ label: "Cookie" }, { label: "Apple" }],
        multiSelect: false,
        allowOther: true,
      },
      { question: "Anything else?", header: "Notes", options: [], allowEmpty: true },
    ],
  },
};

describe("resolveQuestionAnswers", () => {
  test("keeps structured answers and derives the header-keyed text answers", () => {
    const resolved = resolveQuestionAnswers(request, {
      behavior: "allow",
      questionAnswers: [
        { selected: ["Red, bright", "Blue"], text: "Green, dark" },
        { selected: ["Cookie"] },
        { selected: [], text: "" },
      ],
    });

    expect(resolved).toEqual({
      behavior: "allow",
      questionAnswers: [
        { selected: ["Red, bright", "Blue"], text: "Green, dark" },
        { selected: ["Cookie"] },
        { selected: [], text: "" },
      ],
      updatedInput: {
        answers: { Colors: "Red, bright, Blue, Green, dark", Snack: "Cookie", Notes: "" },
      },
    });
  });

  test("reads text answers from clients without structured answers by matching option labels", () => {
    const resolved = resolveQuestionAnswers(request, {
      behavior: "allow",
      updatedInput: {
        answers: { Colors: "Red, bright, Blue, Green", Snack: "Pretzel", Notes: "" },
      },
    });

    expect(resolved).toMatchObject({
      questionAnswers: [
        { selected: ["Red, bright", "Blue"], text: "Green" },
        { selected: [], text: "Pretzel" },
        { selected: [], text: "" },
      ],
      updatedInput: {
        answers: { Colors: "Red, bright, Blue, Green", Snack: "Pretzel", Notes: "" },
      },
    });
  });

  test("rejects structured answers that do not line up with the questions", () => {
    expect(() =>
      resolveQuestionAnswers(request, {
        behavior: "allow",
        questionAnswers: [{ selected: ["Blue"] }],
      }),
    ).toThrow("3 questions");
  });

  test("leaves denials and non-question requests unchanged", () => {
    expect(resolveQuestionAnswers(request, { behavior: "deny" })).toEqual({ behavior: "deny" });
    const tool = { ...request, kind: "tool" as const };
    expect(resolveQuestionAnswers(tool, { behavior: "allow" })).toEqual({ behavior: "allow" });
  });
});
