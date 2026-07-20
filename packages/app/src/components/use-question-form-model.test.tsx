// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import React, { StrictMode, type PropsWithChildren } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type { QuestionFormQuestion } from "./question-form-model";
import { useQuestionFormModel } from "./use-question-form-model";

const QUESTIONS: readonly QuestionFormQuestion[] = [
  {
    key: "target",
    question: "Which target?",
    header: "Target",
    options: [{ value: "mobile", label: "Mobile app" }],
    kind: "single-select",
    allowOther: false,
    allowEmpty: false,
  },
];

function StrictModeWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

describe("useQuestionFormModel", () => {
  afterEach(cleanup);

  test("keeps the model active through Strict Mode effect replay", () => {
    const { result } = renderHook(() => useQuestionFormModel(QUESTIONS), {
      wrapper: StrictModeWrapper,
    });

    act(() => {
      result.current.toggleOption("target", "mobile");
    });

    expect(result.current.getAnswers()).toEqual({ target: "mobile" });
    expect(result.current.getState().canSubmit).toBe(true);
  });
});
