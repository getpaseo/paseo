import { describe, expect, it } from "vitest";
import { buildAnswers, parseQuestions } from "./question-form";

describe("parseQuestions", () => {
  it("reads AskUserQuestion input and defaults free text for option-less questions", () => {
    const questions = parseQuestions({
      questions: [
        {
          question: "Where next?",
          header: "Next step",
          options: [{ label: "Spec", description: "Write it" }, { label: "Build" }],
          multiSelect: false,
          allowOther: true,
        },
        { question: "Anything else?", header: "Notes", options: [] },
      ],
    });
    expect(questions).toHaveLength(2);
    expect(questions?.[0].options[0]).toEqual({ label: "Spec", description: "Write it" });
    expect(questions?.[1].allowOther).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(parseQuestions({ questions: [{ options: [] }] })).toBeNull();
    expect(parseQuestions({})).toBeNull();
  });
});

describe("buildAnswers", () => {
  const questions = parseQuestions({
    questions: [
      {
        question: "Which?",
        header: "Pick",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: true,
      },
      { question: "Why?", header: "Reason", options: [{ label: "Fast" }], allowOther: true },
    ],
  })!;

  it("keys answers by header, joins multi-select labels, and prefers free text", () => {
    const answers = buildAnswers(
      questions,
      new Map([
        [0, new Set([1, 0])],
        [1, new Set([0])],
      ]),
      new Map([[1, "Because it is simpler"]]),
    );
    expect(answers).toEqual({ Pick: "A, B", Reason: "Because it is simpler" });
  });
});
