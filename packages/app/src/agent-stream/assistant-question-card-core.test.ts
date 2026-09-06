import { describe, expect, test } from "vitest";
import type { AssistantQuestion } from "@/timeline/assistant-questions";
import {
  formatAssistantQuestionMessage,
  initialAssistantQuestionSelections,
  isAssistantQuestionAnswerable,
  resolveAssistantQuestionAnswers,
  toQuestionFormQuestion,
} from "./assistant-question-card-core";

const PICK_ONE: AssistantQuestion = { title: "Which runtime?", options: ["Bun", "Node"] };
const OPEN: AssistantQuestion = { title: "Anything else?" };

describe("assistant question card core", () => {
  test("preselects the recommended answer and submits it unchanged", () => {
    const questions = [PICK_ONE].map(toQuestionFormQuestion);
    const selections = initialAssistantQuestionSelections([PICK_ONE]);

    expect(isAssistantQuestionAnswerable(questions, selections, {})).toBe(true);
    const answers = resolveAssistantQuestionAnswers(questions, selections, {});
    expect(answers).toEqual(["Bun"]);
    expect(formatAssistantQuestionMessage(questions, answers ?? [])).toBe("Bun");
  });

  test("free text wins over a selected option", () => {
    const questions = [PICK_ONE].map(toQuestionFormQuestion);
    const selections = initialAssistantQuestionSelections([PICK_ONE]);

    expect(resolveAssistantQuestionAnswers(questions, selections, { 0: "  Deno  " })).toEqual([
      "Deno",
    ]);
  });

  test("a question with no options still takes a free-text answer", () => {
    const questions = [OPEN].map(toQuestionFormQuestion);
    const selections = initialAssistantQuestionSelections([OPEN]);

    expect(selections).toEqual({});
    expect(isAssistantQuestionAnswerable(questions, selections, {})).toBe(false);
    expect(isAssistantQuestionAnswerable(questions, selections, { 0: "ship it" })).toBe(true);
    expect(resolveAssistantQuestionAnswers(questions, selections, { 0: "ship it" })).toEqual([
      "ship it",
    ]);
  });

  test("holds back until every question is answered", () => {
    const questions = [PICK_ONE, OPEN].map(toQuestionFormQuestion);
    const selections = initialAssistantQuestionSelections([PICK_ONE, OPEN]);

    expect(isAssistantQuestionAnswerable(questions, selections, {})).toBe(false);
    expect(resolveAssistantQuestionAnswers(questions, selections, {})).toBeNull();
    expect(resolveAssistantQuestionAnswers(questions, selections, { 1: "no" })).toEqual([
      "Bun",
      "no",
    ]);
  });

  test("labels each answer when there is more than one question", () => {
    const questions = [PICK_ONE, OPEN].map(toQuestionFormQuestion);

    expect(formatAssistantQuestionMessage(questions, ["Bun", "no"])).toBe(
      "Which runtime?: Bun\nAnything else?: no",
    );
  });
});
