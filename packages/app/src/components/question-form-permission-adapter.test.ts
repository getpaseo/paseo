import { describe, expect, test } from "vitest";
import {
  openQuestionForm,
  parseQuestionFormQuestions,
  shouldSubmitEmptyOnDismiss,
} from "./question-form-model";
import { buildQuestionPermissionAnswers } from "./question-form-permission-adapter";

describe("question form permission adapter", () => {
  test("serializes machine keys and values to the existing header and label response shape", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          key: "favorite_drink",
          question: "Which drink?",
          header: "Drink",
          options: [
            { value: "coffee", label: "Coffee" },
            { value: "tea", label: "Tea" },
          ],
        },
        {
          key: "target_surfaces",
          question: "Which surfaces?",
          header: "Targets",
          options: [
            { value: "mobile", label: "Mobile app" },
            { value: "desktop", label: "Desktop app" },
          ],
          multiSelect: true,
        },
        {
          key: "notes",
          question: "Anything else?",
          header: "Notes",
          options: [],
        },
        {
          key: "custom_targets",
          question: "Other targets?",
          header: "Custom targets",
          options: [{ value: "server", label: "Server" }],
          multiSelect: true,
          allowOther: true,
        },
      ],
    });
    if (!questions) throw new Error("questions did not parse");
    const form = openQuestionForm(questions);

    form.toggleOption("favorite_drink", "tea");
    form.toggleOption("target_surfaces", "desktop");
    form.toggleOption("target_surfaces", "mobile");
    form.setTextAnswer("notes", "keep this text");
    form.setTextAnswer("custom_targets", "App, Desktop");

    expect(form.getAnswers()).toMatchObject({
      target_surfaces: ["mobile", "desktop"],
    });
    expect(buildQuestionPermissionAnswers(form.getState(), form.getAnswers())).toEqual({
      Drink: "Tea",
      Targets: "Desktop app, Mobile app",
      Notes: "keep this text",
      "Custom targets": "App, Desktop",
    });
  });

  test("preserves other text that matches an option machine value", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          key: "single_target",
          question: "Which target?",
          header: "Single target",
          options: [{ value: "mobile", label: "Mobile app" }],
          allowOther: true,
        },
        {
          key: "multiple_targets",
          question: "Which targets?",
          header: "Multiple targets",
          options: [{ value: "mobile", label: "Mobile app" }],
          multiSelect: true,
          allowOther: true,
        },
      ],
    });
    if (!questions) throw new Error("questions did not parse");
    const form = openQuestionForm(questions);

    form.setTextAnswer("single_target", "mobile");
    form.setTextAnswer("multiple_targets", "mobile");

    expect(form.getAnswers()).toEqual({
      single_target: "mobile",
      multiple_targets: ["mobile"],
    });
    expect(buildQuestionPermissionAnswers(form.getState(), form.getAnswers())).toEqual({
      "Single target": "mobile",
      "Multiple targets": "mobile",
    });
  });

  test("preserves optional empty text under the display header", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          key: "optional_comment",
          question: "Optional comment?",
          header: "Response",
          options: [],
          allowEmpty: true,
        },
      ],
    });
    if (!questions) throw new Error("questions did not parse");
    const form = openQuestionForm(questions);

    expect(form.getState().canSubmit).toBe(true);
    expect(shouldSubmitEmptyOnDismiss(questions)).toBe(true);
    expect(buildQuestionPermissionAnswers(form.getState(), form.getAnswers())).toEqual({
      Response: "",
    });
  });

  test("omits optional empty other answers from the existing permission wire", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          key: "single_target",
          question: "Which target?",
          header: "Single target",
          options: [{ value: "mobile", label: "Mobile app" }],
          allowOther: true,
          allowEmpty: true,
        },
        {
          key: "multiple_targets",
          question: "Which targets?",
          header: "Multiple targets",
          options: [{ value: "mobile", label: "Mobile app" }],
          multiSelect: true,
          allowOther: true,
          allowEmpty: true,
        },
      ],
    });
    if (!questions) throw new Error("questions did not parse");
    const form = openQuestionForm(questions);

    expect(form.getState().canSubmit).toBe(true);
    expect(form.getAnswers()).toEqual({
      single_target: "",
      multiple_targets: [],
    });
    expect(buildQuestionPermissionAnswers(form.getState(), form.getAnswers())).toEqual({});
  });
});
