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
  return { tail: [], head, submission: null };
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
    const runningObserved = observeMessageSubmissionRunning(accepted.submission);

    expect(accepted.submission).toEqual({
      clientMessageId: "client-1",
      submittedAt: message.timestamp,
      phase: "waiting-for-running",
    });
    expect(getPendingMessageSubmission(accepted.submission)).toEqual(accepted.submission);
    expect(runningObserved).toBeNull();
  });

  it("keeps a row when authoritative running precedes a late RPC error", () => {
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

    const runningObserved = observeMessageSubmissionRunning(begun.submission);
    const rejected = rejectMessageSubmission({ ...begun, submission: runningObserved }, "client-1");

    expect(runningObserved).toEqual({
      clientMessageId: "client-1",
      submittedAt: message.timestamp,
      phase: "running-observed",
    });
    expect(getPendingMessageSubmission(runningObserved)).toBeNull();
    expect(rejected).toEqual({
      outcome: "accepted",
      state: { ...begun, submission: null },
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

    expect(observeMessageSubmissionRunning(begun.submission)).toBe(begun.submission);
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
      submission: {
        clientMessageId: "client-1",
        submittedAt,
        phase: "waiting-for-rpc",
        acceptance: "rpc-only",
      },
    });
    expect(accepted.tail).toBe(begun.tail);
    expect(accepted.head).toBe(begun.head);
    expect(accepted.submission).toBeNull();
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
        submission: null,
      },
    });
  });

  it("treats running-observed as authoritatively accepted", () => {
    const message = createUserMessage({
      clientMessageId: "client-1",
      text: "hello",
      timestamp: new Date("2026-07-26T10:00:00.000Z"),
    });
    const state = initialState([message]);

    const runningObserved = {
      ...state,
      submission: {
        clientMessageId: "client-1",
        submittedAt: message.timestamp,
        phase: "running-observed" as const,
      },
    };

    expect(rejectMessageSubmission(runningObserved, "client-1")).toEqual({
      outcome: "accepted",
      state: { ...runningObserved, submission: null },
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
      { tail: [olderRow], head: [], submission: null },
      {
        message: resubmitted,
        submittedAt: resubmitted.timestamp,
        acceptance: "rpc-and-running",
      },
    );

    expect(begun.tail).toEqual([olderRow, resubmitted]);
  });
});
