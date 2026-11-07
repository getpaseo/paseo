import { describe, expect, test } from "vitest";
import type { CanUseTool, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryFactory } from "./query.js";
import type { AgentPermissionResponse } from "../../agent-sdk-types.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";

// The SDK dependency receives the same permission callback as a real Claude process.
// Keep its stream open until close; permission state belongs entirely to the session.
function createSdkFake() {
  let canUseTool: CanUseTool | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const queryFactory: ClaudeQueryFactory = ({ options }) => {
    canUseTool = options.canUseTool;
    return {
      close: finish,
      return: async () => {
        finish();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<SDKMessage, void>> => {
            await finished;
            return { value: undefined, done: true };
          },
        };
      },
    } as Query;
  };
  return {
    queryFactory,
    ask: (input: Record<string, unknown>) => {
      if (!canUseTool) throw new Error("SDK permission callback was not configured");
      return canUseTool("AskUserQuestion", input, {
        signal: new AbortController().signal,
        toolUseID: "question-tool-call",
      });
    },
  };
}

const questionInput = {
  questions: [{ question: "Which colour?", header: "Colour", options: [], multiSelect: false }],
};

const invalidResponses: Array<[string, AgentPermissionResponse]> = [
  ["selectedActionId", { behavior: "allow", selectedActionId: "Viridian" }],
  ["missing answers", { behavior: "allow", updatedInput: {} }],
  ["unknown question", { behavior: "allow", updatedInput: { answers: { Hue: "Viridian" } } }],
  ["blank answer", { behavior: "allow", updatedInput: { answers: { Colour: " " } } }],
  ["non-string answer", { behavior: "allow", updatedInput: { answers: { Colour: 1 } } }],
  [
    "empty echoed questions",
    { behavior: "allow", updatedInput: { questions: [], answers: { Colour: "Viridian" } } },
  ],
];

describe("Claude question permission responses", () => {
  test.each(invalidResponses)(
    "rejects %s and delivers a corrected retry",
    async (_label, response) => {
      const sdk = createSdkFake();
      const session = await new ClaudeAgentClient({
        logger: createTestLogger(),
        queryFactory: sdk.queryFactory,
        resolveBinary: async () => "/test/claude/bin",
      }).createSession({ provider: "claude", cwd: process.cwd(), modeId: "default" });
      try {
        await session.startTurn("Ask which colour");
        const answer = sdk.ask(questionInput);
        void answer.catch(() => undefined);
        const request = session.getPendingPermissions()[0]!;
        expect(request.kind).toBe("question");
        await expect(session.respondToPermission(request.id, response)).rejects.toMatchObject({
          code: "question_answer_required",
          requestId: request.id,
        });
        expect(session.getPendingPermissions()).toEqual([request]);
        await session.respondToPermission(request.id, {
          behavior: "allow",
          updatedInput: { answers: { Colour: "Viridian" } },
        });
        await expect(answer).resolves.toMatchObject({
          behavior: "allow",
          updatedInput: { answers: { "Which colour?": "Viridian" } },
        });
        expect(session.getPendingPermissions()).toEqual([]);
      } finally {
        await session.close();
      }
    },
  );

  test.each([
    ["header", questionInput, { Colour: "Viridian" }, { "Which colour?": "Viridian" }],
    ["question text", questionInput, { "Which colour?": "Ochre" }, { "Which colour?": "Ochre" }],
    [
      "padded question text",
      { questions: [{ question: " Which colour? ", header: " Colour " }] },
      { " Which colour? ": "Ochre" },
      { " Which colour? ": "Ochre" },
    ],
    [
      "padded header",
      { questions: [{ question: " Which colour? ", header: " Colour " }] },
      { " Colour ": "Viridian" },
      { " Which colour? ": "Viridian" },
    ],
    [
      "partial answer",
      { questions: [...questionInput.questions, { question: "Ship it?", header: "Ship" }] },
      { Ship: "Yes" },
      { "Ship it?": "Yes" },
    ],
  ])("delivers answers keyed by %s", async (_label, input, answers, expected) => {
    const sdk = createSdkFake();
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: sdk.queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    }).createSession({ provider: "claude", cwd: process.cwd(), modeId: "default" });
    try {
      await session.startTurn("Ask which colour");
      const answer = sdk.ask(input);
      void answer.catch(() => undefined);
      const request = session.getPendingPermissions()[0]!;
      await session.respondToPermission(request.id, {
        behavior: "allow",
        updatedInput: { answers },
      });
      await expect(answer).resolves.toMatchObject({
        behavior: "allow",
        updatedInput: { answers: expected },
      });
      expect(session.getPendingPermissions()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("allows denying a question without answers", async () => {
    const sdk = createSdkFake();
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: sdk.queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    }).createSession({ provider: "claude", cwd: process.cwd(), modeId: "default" });
    try {
      await session.startTurn("Ask which colour");
      const answer = sdk.ask(questionInput);
      void answer.catch(() => undefined);
      const request = session.getPendingPermissions()[0]!;
      await session.respondToPermission(request.id, { behavior: "deny", message: "No answer" });
      await expect(answer).resolves.toMatchObject({ behavior: "deny", message: "No answer" });
      expect(session.getPendingPermissions()).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
