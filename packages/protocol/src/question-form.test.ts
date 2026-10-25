import { describe, expect, test } from "vitest";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  draftsForQuestion,
  parseQuestionFormQuestions,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "./question-form.js";

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

  test("keeps checked options and appends the other answer for multi-select", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which fruits do you like?",
          header: "Fruits",
          options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
          multiSelect: true,
          allowOther: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, { 0: new Set([0, 2]) }, { 0: " durian " })).toEqual({
      Fruits: "Apple, Cherry, durian",
    });
    expect(buildQuestionFormAnswers(questions, { 0: new Set([0, 2]) }, {})).toEqual({
      Fruits: "Apple, Cherry",
    });
    expect(buildQuestionFormAnswers(questions, { 0: new Set() }, { 0: "durian" })).toEqual({
      Fruits: "durian",
    });
    expect(buildQuestionFormAnswers(questions, {}, { 0: "durian" })).toEqual({ Fruits: "durian" });
  });

  test("replaces the selected option with the other answer for single-select", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which provider?",
          header: "Provider",
          options: [{ label: "Claude Code" }, { label: "Codex" }],
          multiSelect: false,
          allowOther: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, { 0: "OpenCode" })).toEqual({
      Provider: "OpenCode",
    });
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, {})).toEqual({
      Provider: "Codex",
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

  test("keeps option previews so options can be compared", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which layout?",
          header: "Layout",
          options: [
            {
              label: "Tabs",
              description: "One tab per section",
              preview: "<Tabs>\n  <Tab />\n</Tabs>",
            },
            { label: "Single page" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(questions?.[0]?.options).toEqual([
      { label: "Tabs", description: "One tab per section", preview: "<Tabs>\n  <Tab />\n</Tabs>" },
      { label: "Single page", description: undefined, preview: undefined },
    ]);
  });
});

describe("draftsForQuestion", () => {
  const free = (question: string) => ({ question, header: question, options: [] });
  const pickOnly = { question: "Which?", header: "Which", options: [{ label: "A" }] };

  function parse(questions: unknown[]) {
    const parsed = parseQuestionFormQuestions({ questions });
    if (!parsed) throw new Error("questions did not parse");
    return parsed;
  }

  test("shows each question only the drafts that name it", () => {
    const questions = parse([free("Which database?"), free("Which region?")]);
    const drafts = [
      { id: "s1", text: "Postgres", questionIndex: 0 },
      { id: "s2", text: "eu-west-1", questionIndex: 1 },
      { id: "s3", text: "SQLite", questionIndex: 0 },
    ];

    expect(draftsForQuestion(drafts, 0, questions).map((d) => d.text)).toEqual([
      "Postgres",
      "SQLite",
    ]);
    expect(draftsForQuestion(drafts, 1, questions).map((d) => d.text)).toEqual(["eu-west-1"]);
  });

  test("keeps an unnamed draft only where one question takes typed text", () => {
    const legacy = [{ id: "s1", text: "Postgres" }];

    const sole = parse([pickOnly, free("Which database?")]);
    expect(draftsForQuestion(legacy, 1, sole)).toEqual(legacy);
    expect(draftsForQuestion(legacy, 0, sole)).toEqual([]);

    const two = parse([free("Which database?"), free("Which region?")]);
    expect(draftsForQuestion(legacy, 0, two)).toEqual([]);
    expect(draftsForQuestion(legacy, 1, two)).toEqual([]);
  });

  test("offers nothing for a question without an answer box or out of range", () => {
    const questions = parse([pickOnly]);
    const drafts = [{ id: "s1", text: "B", questionIndex: 0 }];

    expect(draftsForQuestion(drafts, 0, questions)).toEqual([]);
    expect(draftsForQuestion(drafts, 3, questions)).toEqual([]);
  });
});
