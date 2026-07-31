import { describe, expect, it } from "vitest";
import {
  acceptMessageSubmission,
  beginMessageSubmission,
  getActiveMessageSubmissions,
  getSendingClientMessageIds,
  observeMessageSubmissionCanonical,
  rejectMessageSubmission,
} from "./model";

const submittedAt = new Date("2026-07-26T10:00:00.000Z");

describe("message submission transactions", () => {
  it("tracks every in-flight submission independently", () => {
    const first = beginMessageSubmission([], { clientMessageId: "client-1", submittedAt });
    const both = beginMessageSubmission(first, {
      clientMessageId: "client-2",
      submittedAt: new Date(submittedAt.getTime() + 1),
    });

    expect(getActiveMessageSubmissions(both).map((item) => item.clientMessageId)).toEqual([
      "client-1",
      "client-2",
    ]);
    expect(getSendingClientMessageIds(both)).toEqual(["client-1", "client-2"]);
  });

  it("settles only the accepted transaction on RPC acceptance", () => {
    const both = beginMessageSubmission(
      beginMessageSubmission([], { clientMessageId: "client-1", submittedAt }),
      { clientMessageId: "client-2", submittedAt },
    );
    const acknowledged = observeMessageSubmissionCanonical(both, ["client-1"]);

    expect(acceptMessageSubmission(acknowledged, "client-1")).toEqual([
      {
        clientMessageId: "client-2",
        submittedAt,
        providerAcknowledged: false,
        rpcSettled: false,
      },
    ]);
  });

  it("keeps activity until an accepted RPC's canonical row is observed", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1", submittedAt });
    const accepted = acceptMessageSubmission(sending, "client-1");

    expect(accepted).toEqual([
      {
        clientMessageId: "client-1",
        submittedAt,
        providerAcknowledged: false,
        rpcSettled: true,
      },
    ]);
    expect(getActiveMessageSubmissions(accepted).map((item) => item.clientMessageId)).toEqual([
      "client-1",
    ]);
    expect(observeMessageSubmissionCanonical(accepted, ["client-1"])).toEqual([]);
  });

  it("records provider acknowledgement without settling another transaction", () => {
    const both = beginMessageSubmission(
      beginMessageSubmission([], { clientMessageId: "client-1", submittedAt }),
      { clientMessageId: "client-2", submittedAt },
    );
    const observed = observeMessageSubmissionCanonical(both, ["client-1"]);

    expect(observed).toEqual([
      {
        clientMessageId: "client-1",
        submittedAt,
        providerAcknowledged: true,
        rpcSettled: false,
      },
      {
        clientMessageId: "client-2",
        submittedAt,
        providerAcknowledged: false,
        rpcSettled: false,
      },
    ]);
    expect(getSendingClientMessageIds(observed)).toEqual(["client-2"]);
  });

  it("does not roll back a provider-acknowledged prompt on a later transport error", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1", submittedAt });
    const observed = observeMessageSubmissionCanonical(sending, ["client-1"]);

    expect(rejectMessageSubmission(observed, "client-1")).toEqual({
      outcome: "accepted",
      submissions: [],
    });
  });

  it("rejects an unacknowledged transaction", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1", submittedAt });

    expect(rejectMessageSubmission(sending, "client-1")).toEqual({
      outcome: "rejected",
      submissions: [],
    });
  });

  it("does not create duplicate transaction identity", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1", submittedAt });

    expect(() =>
      beginMessageSubmission(sending, { clientMessageId: "client-1", submittedAt }),
    ).toThrow("Message submission already exists");
  });
});
