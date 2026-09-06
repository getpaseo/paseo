import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { createUserMessage, type StreamItem } from "@/types/stream";
import { collectUnansweredQuestionItemIds } from "@/agent-stream/assistant-question-state";
import { readAssistantQuestions } from "./assistant-questions";
import {
  processAgentStreamEvent,
  processTimelineResponse,
  type ProcessTimelineResponseInput,
} from "./session-stream-reducers";

const QUESTIONS = [{ title: "Which runtime?", options: ["Bun", "Node"] }];

function makeAssistantEvent(
  text: string,
  questions?: unknown,
  messageId = "message-1",
): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "codex",
    item: { type: "assistant_message", text, messageId, ...(questions ? { questions } : {}) },
  } as AgentStreamEventPayload;
}

function assistantItems(items: StreamItem[]) {
  return items.filter(
    (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
      item.kind === "assistant_message",
  );
}

describe("readAssistantQuestions", () => {
  it("reads questions off assistant items and nothing else", () => {
    expect(
      readAssistantQuestions({ type: "assistant_message", text: "Which?", questions: QUESTIONS }),
    ).toEqual(QUESTIONS);
    expect(
      readAssistantQuestions({ type: "assistant_message", text: "Done", questions: [] }),
    ).toBeUndefined();
    expect(readAssistantQuestions({ type: "reasoning", text: "hmm" })).toBeUndefined();
  });
});

describe("assistant questions through the stream reducer", () => {
  it("keeps a question-only assistant message with empty text", () => {
    const streamed = processAgentStreamEvent({
      event: makeAssistantEvent("", QUESTIONS),
      seq: 10,
      epoch: "epoch-1",
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      timestamp: new Date(2000),
    });

    const rows = assistantItems([...streamed.tail, ...streamed.head]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("");
    expect(rows[0]?.questions).toEqual(QUESTIONS);
  });

  it("keeps questions when they arrive on a later chunk of the same message", () => {
    const streamed = processAgentStreamEvent({
      event: makeAssistantEvent("Which "),
      seq: 10,
      epoch: "epoch-1",
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      timestamp: new Date(2000),
    });
    expect(assistantItems(streamed.head)[0]?.questions).toBeUndefined();

    const completed = processAgentStreamEvent({
      event: makeAssistantEvent("runtime?", QUESTIONS),
      seq: 11,
      epoch: "epoch-1",
      currentTail: streamed.tail,
      currentHead: streamed.head,
      currentCursor: streamed.cursor ?? undefined,
      timestamp: new Date(2001),
    });

    const rows = assistantItems([...completed.tail, ...completed.head]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("Which runtime?");
    expect(rows[0]?.questions).toEqual(QUESTIONS);
  });

  it("keeps questions when the projected canonical row replaces the live one", () => {
    const streamed = processAgentStreamEvent({
      event: makeAssistantEvent("Which "),
      seq: 10,
      epoch: "epoch-1",
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      timestamp: new Date(2000),
    });

    const canonical = processTimelineResponse({
      payload: {
        agentId: "agent-1",
        direction: "after",
        projection: "projected",
        reset: false,
        epoch: "epoch-1",
        window: { minSeq: 1, maxSeq: 11, nextSeq: 12 },
        startCursor: { seq: 11 },
        endCursor: { seq: 11 },
        entries: [
          {
            seqStart: 11,
            seqEnd: 11,
            provider: "codex",
            item: {
              type: "assistant_message",
              text: "Which runtime?",
              messageId: "message-1",
              questions: QUESTIONS,
            } as AgentTimelineItem,
            timestamp: new Date(2001).toISOString(),
          },
        ],
        error: null,
        hasNewer: false,
        hasOlder: false,
      },
      currentTail: streamed.tail,
      currentHead: streamed.head,
      currentCursor: streamed.cursor ?? undefined,
      isInitializing: false,
      hasActiveInitDeferred: false,
      initRequestDirection: "tail",
      sendingClientMessageIds: [],
    } as ProcessTimelineResponseInput);

    const rows = assistantItems([...canonical.tail, ...canonical.head]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("Which runtime?");
    expect(rows[0]?.questions).toEqual(QUESTIONS);
  });

  it("does not drop questions when a later delta arrives without them", () => {
    const asked = processAgentStreamEvent({
      event: makeAssistantEvent("Which runtime?", QUESTIONS),
      seq: 10,
      epoch: "epoch-1",
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      timestamp: new Date(2000),
    });

    const extended = processAgentStreamEvent({
      event: makeAssistantEvent(" Meanwhile I will keep going."),
      seq: 11,
      epoch: "epoch-1",
      currentTail: asked.tail,
      currentHead: asked.head,
      currentCursor: asked.cursor ?? undefined,
      timestamp: new Date(2001),
    });

    const rows = assistantItems([...extended.tail, ...extended.head]);
    expect(rows.at(-1)?.questions).toEqual(QUESTIONS);
  });
});

describe("collectUnansweredQuestionItemIds", () => {
  const asked = (id: string): StreamItem => ({
    kind: "assistant_message",
    id,
    text: "Which runtime?",
    timestamp: new Date(1),
    questions: QUESTIONS,
  });
  const answered = createUserMessage({ id: "user-1", text: "Bun", timestamp: new Date(2) });

  it("treats a question with no user message after it as unanswered", () => {
    expect([...collectUnansweredQuestionItemIds([asked("a")], [])]).toEqual(["a"]);
    expect([...collectUnansweredQuestionItemIds([], [asked("a")])]).toEqual(["a"]);
  });

  it("treats a question followed by a user message as answered", () => {
    expect([...collectUnansweredQuestionItemIds([asked("a"), answered], [])]).toEqual([]);
    expect([...collectUnansweredQuestionItemIds([asked("a")], [answered])]).toEqual([]);
  });

  it("keeps a question asked after the last user message unanswered", () => {
    expect([...collectUnansweredQuestionItemIds([asked("a"), answered, asked("b")], [])]).toEqual([
      "b",
    ]);
  });
});
