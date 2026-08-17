import { describe, expect, test } from "vitest";
import {
  openQuestionForm,
  parseQuestionFormQuestions,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "./question-form-model";

function parse(input: unknown) {
  const questions = parseQuestionFormQuestions(input);
  if (!questions) throw new Error("questions did not parse");
  return questions;
}

describe("question form model", () => {
  test("returns a single option machine value under the question machine key", () => {
    const questions = parse({
      questions: [
        {
          id: "favorite_drink",
          question: "Which drink do you want?",
          header: "Drink",
          options: [
            { value: "coffee", label: "Coffee" },
            { value: "tea", label: "Tea" },
          ],
          multiSelect: false,
        },
      ],
    });
    const form = openQuestionForm(questions);

    form.toggleOption("favorite_drink", "tea");

    expect(form.getAnswers()).toEqual({ favorite_drink: "tea" });
    expect(form.getState()).toMatchObject({ canSubmit: true, activeQuestionIndex: 0 });
  });

  test("advances after an active single selection but not after a multiple selection", () => {
    const questions = parse({
      questions: [
        {
          key: "single",
          question: "Pick one",
          header: "Single",
          options: [{ value: "one", label: "One" }],
        },
        {
          key: "multiple",
          question: "Pick many",
          header: "Multiple",
          options: [{ value: "many", label: "Many" }],
          multiSelect: true,
        },
        {
          key: "text",
          question: "Type",
          header: "Text",
          options: [],
        },
      ],
    });
    const form = openQuestionForm(questions);

    form.toggleOption("single", "one");
    expect(form.getState().activeQuestionIndex).toBe(1);

    form.toggleOption("multiple", "many");
    expect(form.getState().activeQuestionIndex).toBe(1);
    form.advance();
    expect(form.getState().activeQuestionIndex).toBe(2);
  });

  test("keeps multiple selections as an ordered string array and free input as a string", () => {
    const questions = parse({
      questions: [
        {
          key: "targets",
          question: "Where should this run?",
          header: "Targets",
          options: [
            { value: "app", label: "Mobile app" },
            { value: "desktop", label: "Desktop app" },
          ],
          multiSelect: true,
        },
        {
          key: "notes",
          question: "Anything else?",
          header: "Notes",
          options: [],
          multiSelect: false,
        },
      ],
    });
    const form = openQuestionForm(questions);

    form.toggleOption("targets", "desktop");
    form.toggleOption("targets", "app");
    form.setTextAnswer("notes", "  keep commas, exactly  ");

    expect(form.getAnswers()).toEqual({
      targets: ["app", "desktop"],
      notes: "keep commas, exactly",
    });
    expect(form.getState().canSubmit).toBe(true);
  });

  test("uses typed other text instead of selected option values", () => {
    const questions = parse({
      questions: [
        {
          key: "provider",
          question: "Which provider?",
          header: "Provider",
          options: [{ value: "claude", label: "Claude Code" }],
          multiSelect: false,
          allowOther: true,
        },
      ],
    });
    const form = openQuestionForm(questions);

    form.toggleOption("provider", "claude");
    form.setTextAnswer("provider", "Custom provider");

    expect(form.getAnswers()).toEqual({ provider: "Custom provider" });
    expect(form.getState().selectedOptionValues.get("provider")).toEqual(new Set());
  });

  test("keeps other text as an array for a multi-select question", () => {
    const questions = parse({
      questions: [
        {
          key: "targets",
          question: "Where should this run?",
          header: "Targets",
          options: [
            { value: "app", label: "Mobile app" },
            { value: "desktop", label: "Desktop app" },
          ],
          multiSelect: true,
          allowOther: true,
        },
      ],
    });
    const form = openQuestionForm(questions);

    form.setTextAnswer("targets", "  App, Desktop  ");

    expect(form.getAnswers()).toEqual({ targets: ["App, Desktop"] });
  });

  test("supports the existing isOther alias", () => {
    const questions = parse({
      questions: [
        {
          key: "response",
          question: "Pick or type",
          header: "Response",
          options: [{ value: "a", label: "A" }],
          isOther: true,
        },
      ],
    });
    const [question] = questions;
    if (!question) throw new Error("question missing");
    const form = openQuestionForm(questions);

    form.setTextAnswer("response", "custom");

    expect(questionShowsTextInput(question)).toBe(true);
    expect(form.getAnswers()).toEqual({ response: "custom" });
  });

  test("ignores free text for option-only questions", () => {
    const questions = parse({
      questions: [
        {
          key: "response",
          question: "Pick one",
          header: "Response",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      ],
    });
    const form = openQuestionForm(questions);

    form.setTextAnswer("response", "freeform");
    expect(form.getState().canSubmit).toBe(false);
    expect(form.getAnswers()).toEqual({});

    form.toggleOption("response", "b");
    expect(form.getState().canSubmit).toBe(true);
    expect(form.getAnswers()).toEqual({ response: "b" });
  });

  test("normalizes existing header and label based question payloads at the input boundary", () => {
    const questions = parse({
      questions: [
        {
          question: "Pick one",
          header: "Response",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
        },
      ],
    });

    expect(questions).toEqual([
      {
        key: "Response",
        question: "Pick one",
        header: "Response",
        options: [
          { value: "A", label: "A", description: undefined },
          { value: "B", label: "B", description: undefined },
        ],
        kind: "single-select",
        allowOther: false,
        allowEmpty: false,
        placeholder: undefined,
        dismissLabel: undefined,
      },
    ]);

    const form = openQuestionForm(questions);
    form.toggleOption("Response", "B");
    expect(form.getAnswers()).toEqual({ Response: "B" });
  });

  test("treats optional text prompts as skippable empty string answers", () => {
    const questions = parse({
      questions: [
        {
          key: "comment",
          question: "Optional comment?",
          header: "Comment",
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
          dismissLabel: "Skip",
        },
      ],
    });
    const form = openQuestionForm(questions);

    expect(form.getState().canSubmit).toBe(true);
    expect(form.getAnswers()).toEqual({ comment: "" });
    expect(shouldSubmitEmptyOnDismiss(questions)).toBe(true);
    expect(resolveDismissLabel(questions)).toBe("Skip");
  });

  test("rejects duplicate machine keys and duplicate option machine values", () => {
    expect(
      parseQuestionFormQuestions({
        questions: [
          { key: "same", question: "First", header: "First", options: [] },
          { key: "same", question: "Second", header: "Second", options: [] },
        ],
      }),
    ).toBeNull();
    expect(
      parseQuestionFormQuestions({
        questions: [
          {
            key: "choice",
            question: "Pick",
            header: "Pick",
            options: [
              { value: "same", label: "First label" },
              { value: "same", label: "Second label" },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  test("supports machine keys that match object prototype properties", () => {
    const questions = parse({
      questions: [
        { key: "constructor", question: "First", header: "First", options: [] },
        { key: "toString", question: "Second", header: "Second", options: [] },
        { key: "__proto__", question: "Third", header: "Third", options: [] },
      ],
    });
    const form = openQuestionForm(questions);

    form.setTextAnswer("constructor", "one");
    form.setTextAnswer("toString", "two");
    form.setTextAnswer("__proto__", "three");

    const answers = form.getAnswers();
    expect(Object.keys(answers)).toEqual(["constructor", "toString", "__proto__"]);
    expect(answers.constructor).toBe("one");
    expect(answers.toString).toBe("two");
    expect(answers.__proto__).toBe("three");
    expect(form.getState().canSubmit).toBe(true);
  });
});
