import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";

import {
  buildGrokAskUserQuestionAnswers,
  formatGrokAskUserQuestionDetail,
  formatGrokAskUserQuestionTitle,
  isGrokAskUserQuestionMethod,
  parseGrokAskUserQuestionParams,
} from "./grok-ask-user-question.js";

describe("isGrokAskUserQuestionMethod", () => {
  test("accepts both ACP spellings and the bare tool name", () => {
    expect(isGrokAskUserQuestionMethod("_x.ai/ask_user_question")).toBe(true);
    expect(isGrokAskUserQuestionMethod("x.ai/ask_user_question")).toBe(true);
    expect(isGrokAskUserQuestionMethod("ask_user_question")).toBe(true);
    expect(isGrokAskUserQuestionMethod("_x.ai/session/update")).toBe(false);
  });
});

describe("parseGrokAskUserQuestionParams", () => {
  test("parses the live Grok ACP payload shape", () => {
    expect(
      parseGrokAskUserQuestionParams({
        sessionId: "session-1",
        toolCallId: "call-question-1",
        mode: "default",
        questions: [
          {
            question: "S-13 demo server — hosting",
            options: [
              { label: "Azure Container Apps (Recommended)", description: "Shared demo host" },
              { label: "This Mac Studio" },
            ],
            multiSelect: null,
          },
        ],
      }),
    ).toEqual({
      sessionId: "session-1",
      toolCallId: "call-question-1",
      questions: [
        {
          question: "S-13 demo server — hosting",
          header: "S-13 demo server — hosting",
          options: [
            { label: "Azure Container Apps (Recommended)", description: "Shared demo host" },
            { label: "This Mac Studio" },
          ],
          multiSelect: false,
          allowOther: true,
        },
      ],
    });
  });

  test("rejects an empty questions array", () => {
    expect(() => parseGrokAskUserQuestionParams({ questions: [] })).toThrow(RequestError);
  });
});

describe("buildGrokAskUserQuestionAnswers", () => {
  const questions = [
    {
      question: "Which host?",
      header: "Host",
      options: [{ label: "Azure" }],
      multiSelect: false,
      allowOther: true,
    },
  ];

  test("maps Paseo header-keyed answers onto Grok question text", () => {
    expect(buildGrokAskUserQuestionAnswers(questions, { Host: "Azure" })).toEqual({
      "Which host?": "Azure",
    });
  });

  test("keeps answers already keyed by question text", () => {
    expect(buildGrokAskUserQuestionAnswers(questions, { "Which host?": "Azure" })).toEqual({
      "Which host?": "Azure",
    });
  });
});

describe("formatters", () => {
  test("titles a multi-question request like the Grok tool chip", () => {
    const questions = [
      {
        question: "One",
        header: "One",
        options: [],
        multiSelect: false,
        allowOther: true,
      },
      {
        question: "Two",
        header: "Two",
        options: [],
        multiSelect: false,
        allowOther: true,
      },
    ];
    expect(formatGrokAskUserQuestionTitle(questions)).toBe("Ask 2 questions");
    expect(formatGrokAskUserQuestionDetail(questions)).toBe("One\nTwo");
  });
});
