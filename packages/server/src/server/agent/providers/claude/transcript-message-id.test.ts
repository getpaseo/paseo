import { describe, expect, it } from "vitest";
import {
  readApiMessageIdFromContainer,
  resolveClaudeTranscriptMessageId,
} from "./transcript-message-id.js";

describe("resolveClaudeTranscriptMessageId", () => {
  it("returns a known transcript uuid unchanged", () => {
    expect(
      resolveClaudeTranscriptMessageId({
        candidate: "uuid-assistant-1",
        knownTranscriptUuids: ["uuid-assistant-1"],
      }),
    ).toBe("uuid-assistant-1");
  });

  it("maps an API message id through the live alias map", () => {
    expect(
      resolveClaudeTranscriptMessageId({
        candidate: "msg_011CdokQULJhdFpNj63Pcv83",
        apiMessageIdToTranscriptUuid: new Map([
          ["msg_011CdokQULJhdFpNj63Pcv83", "uuid-assistant-1"],
        ]),
      }),
    ).toBe("uuid-assistant-1");
  });

  it("maps an API message id via session transcript messages", () => {
    expect(
      resolveClaudeTranscriptMessageId({
        candidate: "msg_011CdokQULJhdFpNj63Pcv83",
        sessionMessages: [
          { uuid: "uuid-user-1", apiMessageId: null },
          {
            uuid: "uuid-assistant-1",
            apiMessageId: "msg_011CdokQULJhdFpNj63Pcv83",
          },
        ],
      }),
    ).toBe("uuid-assistant-1");
  });

  it("rejects unmapped API message ids instead of passing them to the SDK", () => {
    expect(() =>
      resolveClaudeTranscriptMessageId({
        candidate: "msg_011CdokQULJhdFpNj63Pcv83",
      }),
    ).toThrow(/Invalid upToMessageId: msg_011CdokQULJhdFpNj63Pcv83/);
  });

  it("rejects empty candidates", () => {
    expect(() =>
      resolveClaudeTranscriptMessageId({
        candidate: "   ",
      }),
    ).toThrow(/boundary message id/i);
  });

  it("passes unknown non-API ids through for SDK validation", () => {
    expect(
      resolveClaudeTranscriptMessageId({
        candidate: "167129a9-54c4-9225-b054-91b56e1f7071",
      }),
    ).toBe("167129a9-54c4-9225-b054-91b56e1f7071");
  });
});

describe("readApiMessageIdFromContainer", () => {
  it("reads message.id", () => {
    expect(readApiMessageIdFromContainer({ id: "msg_abc", role: "assistant" })).toBe("msg_abc");
  });

  it("reads message_id when id is absent", () => {
    expect(readApiMessageIdFromContainer({ message_id: "msg_def" })).toBe("msg_def");
  });
});
