import { describe, expect, test } from "vitest";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  parseQuestionFormQuestions,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "./question-form-card-core";

describe("question form card core", () => {
  test("treats optional input prompts as skippable empty answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Optional comment?",
          header: "Response",
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
          dismissLabel: "Skip",
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(areQuestionsAnswered(questions, {}, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, {})).toEqual({ Response: "" });
    expect(shouldSubmitEmptyOnDismiss(questions)).toBe(true);
    expect(resolveDismissLabel(questions)).toBe("Skip");
  });

  test("requires a selection for option-only questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick one",
          header: "Response",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(false);
    expect(areQuestionsAnswered(questions, {}, { 0: "freeform" })).toBe(false);
    expect(areQuestionsAnswered(questions, { 0: new Set([1]) }, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, {})).toEqual({
      Response: "B",
    });
  });

  test("shows text input for explicit other questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          isOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  test("shows text input for questions that allow other answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          allowOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  test("keys v2 form answers by the field key, not the header", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          key: "q0",
          title: "Name",
          type: "string",
          description: "What is your name?",
          required: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, {}, { 0: "Ada" })).toEqual({
      q0: "Ada",
    });
  });

  test("uses the option value for a selected v2 string option", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          key: "q0",
          title: "Color",
          type: "string",
          options: [
            { label: "Red", value: "red" },
            { label: "Blue", value: "blue" },
          ],
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, {})).toEqual({
      q0: "blue",
    });
  });

  test("builds a string array of option values for a v2 multiselect", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          key: "q1",
          title: "Tags",
          type: "multiselect",
          options: [
            { label: "a", value: "a" },
            { label: "b", value: "b" },
            { label: "c", value: "c" },
          ],
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, { 0: new Set([0, 2]) }, {})).toEqual({
      q1: ["a", "c"],
    });
  });

  test("coerces a v2 number field answer to a number", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          key: "q2",
          title: "Count",
          type: "number",
          minimum: 1,
          maximum: 10,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, {}, { 0: "3" })).toEqual({
      q2: 3,
    });
  });

  test("coerces a v2 boolean field answer to a boolean", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          key: "q3",
          title: "Enable",
          type: "boolean",
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, {}, { 0: "true" })).toEqual({
      q3: true,
    });
  });
});
