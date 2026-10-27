import { afterEach, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import type { UserMessageItem } from "@/types/stream";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { createMessageSubmissionWriter, transferComposerFollowUps } from "./writer";

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

const TRANSFER_SERVER_ID = "transfer";

function queued(id: string) {
  return { id, text: `follow-up ${id}`, attachments: [] };
}
function queueIds(agentId: string): string[] {
  return (
    useSessionStore.getState().sessions[TRANSFER_SERVER_ID]?.queuedMessages.get(agentId) ?? []
  ).map((item) => item.id);
}
function draftText(agentId: string): string | undefined {
  return useDraftStore
    .getState()
    .getDraftInput(buildDraftStoreKey({ serverId: TRANSFER_SERVER_ID, agentId }))?.text;
}
function typeDraft(agentId: string, text: string): void {
  useDraftStore.getState().saveDraftInput({
    draftKey: buildDraftStoreKey({ serverId: TRANSFER_SERVER_ID, agentId }),
    draft: { text, attachments: [] },
  });
}

test("follow-ups move with their IDs and order behind the destination's, and only once", () => {
  initializeSession(TRANSFER_SERVER_ID, {});
  useSessionStore.getState().setQueuedMessages(
    TRANSFER_SERVER_ID,
    new Map([
      ["optimistic", [queued("a"), queued("b")]],
      ["recovery", [queued("earlier")]],
    ]),
  );
  typeDraft("optimistic", "typed but unsent");

  transferComposerFollowUps(TRANSFER_SERVER_ID, "optimistic", "recovery");
  transferComposerFollowUps(TRANSFER_SERVER_ID, "optimistic", "recovery");
  transferComposerFollowUps(TRANSFER_SERVER_ID, "recovery", "recovery");

  expect(queueIds("recovery")).toEqual(["earlier", "a", "b"]);
  expect(queueIds("optimistic")).toEqual([]);
  expect(draftText("recovery")).toBe("typed but unsent");
  expect(draftText("optimistic")).toBeUndefined();
  useSessionStore.getState().clearSession(TRANSFER_SERVER_ID);
});

test("unsent text never replaces a destination draft and stays at its source", () => {
  initializeSession(TRANSFER_SERVER_ID, {});
  typeDraft("source", "typed on the source");
  typeDraft("destination", "already typed here");

  transferComposerFollowUps(TRANSFER_SERVER_ID, "source", "destination");

  expect(draftText("destination")).toBe("already typed here");
  expect(draftText("source")).toBe("typed on the source");
  useSessionStore.getState().clearSession(TRANSFER_SERVER_ID);
});
