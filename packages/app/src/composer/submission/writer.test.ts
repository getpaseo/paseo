import { afterEach, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import type { UserMessageItem } from "@/types/stream";
import { createMessageSubmissionWriter } from "./writer";

const CANONICAL_ONLY_SERVER_ID = "canonical-only";

function submittedMessage(clientMessageId: string): UserMessageItem {
  return {
    kind: "user_message",
    id: clientMessageId,
    clientMessageId,
    text: "hello",
    timestamp: new Date("2026-07-31T10:00:00.000Z"),
  };
}

function initializeSession(serverId: string, features: Record<string, boolean>): void {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: "0.2.6",
    features,
  });
}

function submissionIds(serverId: string): string[] {
  return (
    useSessionStore.getState().sessions[serverId]?.messageSubmissions.get("agent-1") ?? []
  ).map((submission) => submission.clientMessageId);
}

afterEach(() => {
  useSessionStore.getState().clearSession(CANONICAL_ONLY_SERVER_ID);
});

test("tracks submissions when canonical prompts are supported", () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });

  createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID).begin(
    "agent-1",
    submittedMessage("canonical-only-message"),
  );

  expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual(["canonical-only-message"]);
});

test("retrying a pending submission retains one timeline row and one transaction", () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });
  const writer = createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID);
  const message = submittedMessage("retry-message");
  writer.begin("agent-1", message);
  writer.begin("agent-1", message);
  const session = useSessionStore.getState().sessions[CANONICAL_ONLY_SERVER_ID];
  expect(session.agentStreamTail.get("agent-1")).toEqual([message]);
  expect(session.agentStreamHead.get("agent-1") ?? []).toEqual([]);
  expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual(["retry-message"]);
});

test("retrying a canonical message keeps its timeline position and settles without another echo", () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });
  const canonical = { ...submittedMessage("accepted-message"), messageId: "provider-message" };
  useSessionStore.getState().setAgentStreamState(CANONICAL_ONLY_SERVER_ID, "agent-1", {
    tail: [canonical],
    head: [],
  });
  const writer = createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID);
  writer.begin("agent-1", submittedMessage("accepted-message"));
  writer.accept("agent-1", "accepted-message");
  expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual([]);
  expect(
    useSessionStore.getState().sessions[CANONICAL_ONLY_SERVER_ID].agentStreamTail.get("agent-1"),
  ).toEqual([canonical]);
});

test("a failed same-ID retry preserves an accepted send awaiting its canonical echo", () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });
  const writer = createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID);
  const message = submittedMessage("accepted-before-retry");
  writer.begin("agent-1", message);
  writer.accept("agent-1", message.clientMessageId!);
  writer.begin("agent-1", message);
  expect(writer.reject("agent-1", message.clientMessageId!)).toBe("accepted");
  expect(
    useSessionStore.getState().sessions[CANONICAL_ONLY_SERVER_ID].agentStreamTail.get("agent-1"),
  ).toEqual([message]);
  expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual([message.clientMessageId]);
});

for (const finalOutcome of ["accept", "reject"] as const) {
  test(`one failed overlapping attempt preserves the pending attempt until ${finalOutcome}`, () => {
    initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });
    const writer = createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID);
    const message = submittedMessage("overlap");
    writer.begin("agent-1", message);
    writer.begin("agent-1", message);
    expect(writer.reject("agent-1", "overlap")).toBe("unknown");
    expect(
      useSessionStore.getState().sessions[CANONICAL_ONLY_SERVER_ID].agentStreamTail.get("agent-1"),
    ).toEqual([message]);
    if (finalOutcome === "accept") {
      writer.accept("agent-1", "overlap");
      expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual(["overlap"]);
    } else {
      expect(writer.reject("agent-1", "overlap")).toBe("rejected");
      expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual([]);
    }
  });
}

test("a prior canonical attempt does not prove that a failed same-ID retry was accepted", () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });
  const canonical = { ...submittedMessage("rejected-history"), messageId: "rejected-history" };
  useSessionStore
    .getState()
    .setAgentStreamState(CANONICAL_ONLY_SERVER_ID, "agent-1", { tail: [canonical], head: [] });
  const writer = createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID);
  writer.begin("agent-1", submittedMessage("rejected-history"));
  expect(writer.reject("agent-1", "rejected-history")).toBe("rejected");
  expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual([]);
  expect(
    useSessionStore.getState().sessions[CANONICAL_ONLY_SERVER_ID].agentStreamTail.get("agent-1"),
  ).toEqual([canonical]);
});

test.each<Record<string, boolean>>([{}, { canonicalSubmittedPrompts: false }])(
  "older hosts refuse same-ID retries without removing the accepted prompt (%j)",
  (features) => {
    initializeSession(CANONICAL_ONLY_SERVER_ID, features);
    const writer = createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID);
    const message = submittedMessage("legacy-accepted");
    writer.begin("agent-1", message);
    writer.accept("agent-1", message.clientMessageId!);
    const retryWriter = createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID);
    expect(() => retryWriter.begin("agent-1", message)).toThrow("Update the Paseo host");
    expect(
      useSessionStore.getState().sessions[CANONICAL_ONLY_SERVER_ID].agentStreamTail.get("agent-1"),
    ).toEqual([message]);
  },
);
