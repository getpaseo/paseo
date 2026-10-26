import { afterEach, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import type { UserMessageItem } from "@/types/stream";
import { getActiveMessageSubmissions } from "./model";
import {
  createMessageSubmissionWriter,
  showDaemonSentAgentMessage,
  updateShownAgentMessage,
  withdrawDaemonSentAgentMessage,
} from "./writer";

const CANONICAL_ONLY_SERVER_ID = "canonical-only";
const DAEMON_SENT_SERVER_ID = "daemon-sent";

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
  useSessionStore.getState().clearSession(DAEMON_SENT_SERVER_ID);
});

test("tracks submissions when canonical prompts are supported", () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });

  createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID).begin(
    "agent-1",
    submittedMessage("canonical-only-message"),
  );

  expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual(["canonical-only-message"]);
});

test("shows a daemon-sent message as sending until its canonical copy retires it", () => {
  initializeSession(DAEMON_SENT_SERVER_ID, { canonicalSubmittedPrompts: true });
  const session = () => useSessionStore.getState().sessions[DAEMON_SENT_SERVER_ID]!;

  showDaemonSentAgentMessage(DAEMON_SENT_SERVER_ID, "agent-1", submittedMessage("first-prompt"));
  // A second open of the same agent neither duplicates nor throws.
  showDaemonSentAgentMessage(DAEMON_SENT_SERVER_ID, "agent-1", submittedMessage("first-prompt"));

  expect(
    session()
      .agentStreamTail.get("agent-1")
      ?.map((item) => item.id),
  ).toEqual(["first-prompt"]);
  expect(
    getActiveMessageSubmissions(session().messageSubmissions.get("agent-1")).map(
      (submission) => submission.clientMessageId,
    ),
  ).toEqual(["first-prompt"]);

  useSessionStore.getState().setAgentStreamState(DAEMON_SENT_SERVER_ID, "agent-1", {
    acknowledgedClientMessageIds: ["first-prompt"],
  });
  expect(submissionIds(DAEMON_SENT_SERVER_ID)).toEqual([]);
});

test("does not track a daemon-sent message the stream already shows", () => {
  initializeSession(DAEMON_SENT_SERVER_ID, { canonicalSubmittedPrompts: true });
  useSessionStore.getState().setAgentStreamState(DAEMON_SENT_SERVER_ID, "agent-1", {
    tail: [{ ...submittedMessage("first-prompt"), messageId: "canonical-1" }],
  });

  showDaemonSentAgentMessage(DAEMON_SENT_SERVER_ID, "agent-1", submittedMessage("first-prompt"));

  expect(submissionIds(DAEMON_SENT_SERVER_ID)).toEqual([]);
  expect(
    useSessionStore
      .getState()
      .sessions[DAEMON_SENT_SERVER_ID]!.agentStreamTail.get("agent-1")
      ?.map((item) => item.id),
  ).toEqual(["first-prompt"]);
});

test("adds images to a shown message and keeps its canonical identity", () => {
  initializeSession(DAEMON_SENT_SERVER_ID, { canonicalSubmittedPrompts: true });
  const image = {
    id: "image-1",
    mimeType: "image/png",
    storageType: "web-indexeddb" as const,
    storageKey: "image-1",
    createdAt: 1,
  };
  useSessionStore.getState().setAgentStreamState(DAEMON_SENT_SERVER_ID, "agent-1", {
    tail: [{ ...submittedMessage("first-prompt"), messageId: "canonical-1" }],
  });

  updateShownAgentMessage(DAEMON_SENT_SERVER_ID, "agent-1", {
    ...submittedMessage("first-prompt"),
    images: [image],
  });
  // A message the stream does not show is not added.
  updateShownAgentMessage(DAEMON_SENT_SERVER_ID, "agent-1", submittedMessage("other-prompt"));

  const tail =
    useSessionStore.getState().sessions[DAEMON_SENT_SERVER_ID]!.agentStreamTail.get("agent-1") ??
    [];
  expect(tail).toHaveLength(1);
  expect(tail[0]).toMatchObject({
    clientMessageId: "first-prompt",
    messageId: "canonical-1",
    images: [image],
  });
});

test("withdraws a daemon-sent message that is still sending, so the agent stops reading as busy", () => {
  initializeSession(DAEMON_SENT_SERVER_ID, { canonicalSubmittedPrompts: true });
  showDaemonSentAgentMessage(DAEMON_SENT_SERVER_ID, "agent-1", submittedMessage("first-prompt"));
  expect(
    selectAgentTurnPresentation(
      useSessionStore.getState().sessions[DAEMON_SENT_SERVER_ID],
      "agent-1",
    ).isActive,
  ).toBe(true);

  withdrawDaemonSentAgentMessage(DAEMON_SENT_SERVER_ID, "agent-1", "first-prompt");

  const session = useSessionStore.getState().sessions[DAEMON_SENT_SERVER_ID]!;
  expect(submissionIds(DAEMON_SENT_SERVER_ID)).toEqual([]);
  expect(session.agentStreamTail.get("agent-1") ?? []).toEqual([]);
  expect(selectAgentTurnPresentation(session, "agent-1").isActive).toBe(false);
});

test("keeps a daemon-sent message once its canonical copy has arrived", () => {
  initializeSession(DAEMON_SENT_SERVER_ID, { canonicalSubmittedPrompts: true });
  showDaemonSentAgentMessage(DAEMON_SENT_SERVER_ID, "agent-1", submittedMessage("first-prompt"));
  useSessionStore.getState().setAgentStreamState(DAEMON_SENT_SERVER_ID, "agent-1", {
    acknowledgedClientMessageIds: ["first-prompt"],
  });

  withdrawDaemonSentAgentMessage(DAEMON_SENT_SERVER_ID, "agent-1", "first-prompt");

  expect(
    useSessionStore
      .getState()
      .sessions[DAEMON_SENT_SERVER_ID]!.agentStreamTail.get("agent-1")
      ?.map((item) => item.id),
  ).toEqual(["first-prompt"]);
});
