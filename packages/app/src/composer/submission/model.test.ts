import { describe, expect, it } from "vitest";
import { createUserMessage, type StreamItem } from "@/types/stream";
import {
  acceptMessageSubmission,
  beginMessageSubmission,
  getPendingMessageSubmission,
  observeMessageSubmissionRunning,
  rejectMessageSubmission,
  type MessageSubmissionState,
} from "./model";

function initialState(head: StreamItem[] = []): MessageSubmissionState {
  return { tail: [], head, submissions: [] };
}

describe("message submission model", () => {
  it("waits for authoritative running after RPC acceptance", () => {
    const message = createUserMessage({
      clientMessageId: "client-1",
      text: "hello",
      timestamp: new Date("2026-07-26T10:00:00.000Z"),
    });
    const begun = beginMessageSubmission(initialState(), {
      message,
      submittedAt: message.timestamp,
      acceptance: "rpc-and-running",
    });

    const accepted = acceptMessageSubmission(begun, "client-1");
    const runningObserved = observeMessageSubmissionRunning(accepted.submissions);

    expect(accepted.submissions).toEqual([
      {
        clientMessageId: "client-1",
        submittedAt: message.timestamp,
        phase: "waiting-for-running",
      },
    ]);
    expect(getPendingMessageSubmission(accepted.submissions)).toEqual(accepted.submissions[0]);
    expect(runningObserved).toEqual([]);
  });

  it("rejects a row when an unrelated running transition precedes its RPC error", () => {
    const message = createUserMessage({
      clientMessageId: "client-1",
      text: "hello",
      timestamp: new Date("2026-07-26T10:00:00.000Z"),
    });
    const begun = beginMessageSubmission(initialState(), {
      message,
      submittedAt: message.timestamp,
      acceptance: "rpc-and-running",
    });

    const runningObserved = observeMessageSubmissionRunning(begun.submissions);
    const rejected = rejectMessageSubmission(
      { ...begun, submissions: runningObserved },
      "client-1",
    );

    expect(runningObserved).toBe(begun.submissions);
    expect(getPendingMessageSubmission(runningObserved)).toEqual(runningObserved[0]);
    expect(rejected).toEqual({
      outcome: "rejected",
      state: { tail: [], head: [], submissions: [] },
    });
  });

  it("does not accept an already-running force send from agent status alone", () => {
    const message = createUserMessage({
      clientMessageId: "client-1",
      text: "hello",
      timestamp: new Date("2026-07-26T10:00:00.000Z"),
    });
    const begun = beginMessageSubmission(initialState(), {
      message,
      submittedAt: message.timestamp,
      acceptance: "rpc-only",
    });

    expect(observeMessageSubmissionRunning(begun.submissions)).toBe(begun.submissions);
  });

  it("begins and accepts without changing the submitted row", () => {
    const submittedAt = new Date("2026-07-26T10:00:00.000Z");
    const message = createUserMessage({
      clientMessageId: "client-1",
      text: "hello",
      timestamp: submittedAt,
    });

    const begun = beginMessageSubmission(initialState(), {
      message,
      submittedAt,
      acceptance: "rpc-only",
    });
    const accepted = acceptMessageSubmission(begun, "client-1");

    expect(begun).toEqual({
      tail: [message],
      head: [],
      submissions: [
        {
          clientMessageId: "client-1",
          submittedAt,
          phase: "waiting-for-rpc",
          acceptance: "rpc-only",
        },
      ],
    });
    expect(accepted.tail).toBe(begun.tail);
    expect(accepted.head).toBe(begun.head);
    expect(accepted.submissions).toEqual([]);
  });

  it("rejects by removing the submitted row and closing pending", () => {
    const submittedAt = new Date("2026-07-26T10:00:00.000Z");
    const message = createUserMessage({
      clientMessageId: "client-1",
      text: "hello",
      timestamp: submittedAt,
    });
    const existingHead = createUserMessage({
      id: "provider-prior",
      messageId: "provider-prior",
      text: "prior",
      timestamp: new Date(0),
    });
    const begun = beginMessageSubmission(initialState([existingHead]), {
      message,
      submittedAt,
      acceptance: "rpc-and-running",
    });

    expect(rejectMessageSubmission(begun, "client-1")).toEqual({
      outcome: "rejected",
      state: {
        tail: [],
        head: [existingHead],
        submissions: [],
      },
    });
  });

  it("treats RPC acceptance waiting for running as authoritatively accepted", () => {
    const message = createUserMessage({
      clientMessageId: "client-1",
      text: "hello",
      timestamp: new Date("2026-07-26T10:00:00.000Z"),
    });
    const state = initialState([message]);

    const waitingForRunning = {
      ...state,
      submissions: [
        {
          clientMessageId: "client-1",
          submittedAt: message.timestamp,
          phase: "waiting-for-running" as const,
        },
      ],
    };

    expect(rejectMessageSubmission(waitingForRunning, "client-1")).toEqual({
      outcome: "accepted",
      state: { ...waitingForRunning, submissions: [] },
    });
  });

  it("reports unknown when neither pending nor its submitted row exists", () => {
    const state = initialState();

    expect(rejectMessageSubmission(state, "client-1")).toEqual({
      outcome: "unknown",
      state,
    });
  });
});

describe("submitting alongside repeated history", () => {
  it("appends a resubmitted prompt instead of adopting an identical older row", () => {
    // A row from a daemon that never recorded clientMessageId, e.g. history created
    // before the field existed. Sending the same text again must be a new message.
    const olderRow = createUserMessage({
      id: "provider-1",
      messageId: "provider-1",
      text: "continue",
      timestamp: new Date("2026-07-26T10:00:00.000Z"),
    });
    const resubmitted = createUserMessage({
      clientMessageId: "client-2",
      text: "continue",
      timestamp: new Date("2026-07-26T10:05:00.000Z"),
      attachments: [{ type: "text", mimeType: "text/plain", text: "attachment" }],
    });

    const begun = beginMessageSubmission(
      { tail: [olderRow], head: [], submissions: [] },
      {
        message: resubmitted,
        submittedAt: resubmitted.timestamp,
        acceptance: "rpc-and-running",
      },
    );

    expect(begun.tail).toEqual([olderRow, resubmitted]);
  });
});
