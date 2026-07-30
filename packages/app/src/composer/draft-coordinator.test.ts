import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import { createComposerDraftCoordinator, type ComposerDraftSnapshot } from "./draft-coordinator";

type ComposerDraftCoordinator = ReturnType<typeof createComposerDraftCoordinator>;

function image(id: string): UserComposerAttachment {
  return {
    kind: "image",
    metadata: {
      id,
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: id,
      createdAt: 1,
    },
  };
}

function file(id: string): UserComposerAttachment {
  return {
    kind: "file",
    attachment: {
      type: "uploaded_file",
      id,
      fileName: `${id}.txt`,
      mimeType: "text/plain",
      size: 12,
      path: `/uploads/${id}.txt`,
    },
  };
}

function syncDraft(
  coordinator: ComposerDraftCoordinator,
  ownerId: string,
  draft: ComposerDraftSnapshot,
): void {
  coordinator.syncDraft({ ownerId, draft });
}

function startAttempt(
  coordinator: ComposerDraftCoordinator,
  ownerId: string,
  draft: ComposerDraftSnapshot,
): number | null {
  return coordinator.beginDraftAttempt({ ownerId, draft });
}

describe("composer draft coordinator", () => {
  it("accepts the latest synchronously updated draft without a render refresh", () => {
    const coordinator = createComposerDraftCoordinator();
    const rendered = { text: "rendered draft", attachments: [] };
    const latest = { text: "latest draft", attachments: [image("latest")] };

    syncDraft(coordinator, "agent-a", rendered);
    syncDraft(coordinator, "agent-a", latest);

    expect(startAttempt(coordinator, "agent-a", latest)).toBe(1);
  });

  it("rejects another draft attempt while one is pending", () => {
    const coordinator = createComposerDraftCoordinator();
    const draft = { text: "send once", attachments: [] };

    syncDraft(coordinator, "agent-a", draft);
    expect(startAttempt(coordinator, "agent-a", draft)).toBe(1);
    expect(startAttempt(coordinator, "agent-a", draft)).toBeNull();
    expect(coordinator.getSnapshot("agent-a")?.pending?.kind).toBe("draft");
  });

  it("keeps typing and attachments entered while an attempt is pending", () => {
    const coordinator = createComposerDraftCoordinator();
    const attempted = { text: "attempted", attachments: [image("attempted")] };
    const current = { text: "typed during send", attachments: [file("current")] };

    syncDraft(coordinator, "agent-a", attempted);
    startAttempt(coordinator, "agent-a", attempted);
    syncDraft(coordinator, "agent-a", current);

    expect(coordinator.getSnapshot("agent-a")?.draft).toEqual(current);
  });

  it("restores a failed draft before current input and preserves duplicate text", () => {
    const coordinator = createComposerDraftCoordinator();
    const attemptedShared = image("shared");
    const attempted = {
      text: "same text",
      attachments: [attemptedShared, file("attempted")],
    };
    const current = {
      text: "same text",
      attachments: [image("shared"), file("current")],
    };

    syncDraft(coordinator, "agent-a", attempted);
    startAttempt(coordinator, "agent-a", attempted);
    syncDraft(coordinator, "agent-a", current);

    expect(
      coordinator.settleDraftAttempt({
        ownerId: "agent-a",
        attemptId: 1,
        outcome: "failed",
      }),
    ).toEqual({
      text: "same text\n\nsame text",
      attachments: [attemptedShared, attempted.attachments[1], current.attachments[1]],
    });
  });

  it("preserves current input when a draft attempt succeeds", () => {
    const coordinator = createComposerDraftCoordinator();
    const attempted = { text: "attempted", attachments: [] };
    const current = { text: "typed during send", attachments: [file("current")] };

    syncDraft(coordinator, "agent-a", attempted);
    startAttempt(coordinator, "agent-a", attempted);
    syncDraft(coordinator, "agent-a", current);

    expect(
      coordinator.settleDraftAttempt({
        ownerId: "agent-a",
        attemptId: 1,
        outcome: "accepted",
      }),
    ).toBeNull();
    expect(coordinator.getSnapshot("agent-a")?.draft).toEqual(current);
  });

  it("allows a new draft attempt after either successful or failed settlement", () => {
    const coordinator = createComposerDraftCoordinator();
    const repeated = { text: "repeat me", attachments: [] };

    syncDraft(coordinator, "agent-a", repeated);
    startAttempt(coordinator, "agent-a", repeated);
    coordinator.settleDraftAttempt({
      ownerId: "agent-a",
      attemptId: 1,
      outcome: "accepted",
    });
    syncDraft(coordinator, "agent-a", repeated);

    expect(startAttempt(coordinator, "agent-a", repeated)).toBe(2);
    coordinator.settleDraftAttempt({
      ownerId: "agent-a",
      attemptId: 2,
      outcome: "failed",
    });
    syncDraft(coordinator, "agent-a", repeated);

    expect(startAttempt(coordinator, "agent-a", repeated)).toBe(3);
  });

  it("merges an edited queued draft before input entered during its cancel request", () => {
    const coordinator = createComposerDraftCoordinator();
    const initial = { text: "draft before edit", attachments: [image("shared")] };
    const current = {
      text: "draft before edit plus new typing",
      attachments: [image("shared"), file("current")],
    };
    const queued = { text: "older queued message", attachments: [image("queued")] };

    syncDraft(coordinator, "agent-a", initial);
    coordinator.beginQueuedAction({
      ownerId: "agent-a",
      currentDraft: initial,
      messageId: "queued-1",
      action: "edit",
    });
    syncDraft(coordinator, "agent-a", current);

    expect(
      coordinator.settleQueuedAction({
        ownerId: "agent-a",
        messageId: "queued-1",
        action: "edit",
        outcome: { kind: "edited", draft: queued },
      }),
    ).toEqual({
      text: "older queued message\n\ndraft before edit plus new typing",
      attachments: [...queued.attachments, ...current.attachments],
    });
  });

  it("preserves current input when a queued edit fails", () => {
    const coordinator = createComposerDraftCoordinator();
    const initial = { text: "draft before edit", attachments: [] };
    const current = { text: "typed while cancelling", attachments: [file("current")] };

    syncDraft(coordinator, "agent-a", initial);
    coordinator.beginQueuedAction({
      ownerId: "agent-a",
      currentDraft: initial,
      messageId: "queued-1",
      action: "edit",
    });
    syncDraft(coordinator, "agent-a", current);

    expect(
      coordinator.settleQueuedAction({
        ownerId: "agent-a",
        messageId: "queued-1",
        action: "edit",
        outcome: { kind: "failed" },
      }),
    ).toBeNull();
    expect(coordinator.getSnapshot("agent-a")?.draft).toEqual(current);
  });

  it("settles an attempt only against its originating owner after retargeting", () => {
    const coordinator = createComposerDraftCoordinator();
    const attempted = { text: "agent A attempted", attachments: [image("agent-a")] };
    const agentACurrent = { text: "agent A current", attachments: [file("agent-a-current")] };
    const agentB = { text: "agent B draft", attachments: [image("agent-b")] };

    syncDraft(coordinator, "agent-a", attempted);
    startAttempt(coordinator, "agent-a", attempted);
    syncDraft(coordinator, "agent-a", agentACurrent);
    syncDraft(coordinator, "agent-b", agentB);
    expect(
      coordinator.beginQueuedAction({
        ownerId: "agent-b",
        currentDraft: agentB,
        messageId: "agent-b-queued",
        action: "send",
      }),
    ).toBe(true);

    expect(
      coordinator.settleDraftAttempt({
        ownerId: "agent-a",
        attemptId: 1,
        outcome: "failed",
      }),
    ).toEqual({
      text: "agent A attempted\n\nagent A current",
      attachments: [...attempted.attachments, ...agentACurrent.attachments],
    });
    expect(coordinator.getSnapshot("agent-b")?.draft).toEqual(agentB);
    expect(coordinator.getSnapshot("agent-b")?.pending).toEqual({
      kind: "queued",
      messageId: "agent-b-queued",
      action: "send",
    });
  });

  it("excludes draft attempts and queued actions while any owner action is pending", () => {
    const coordinator = createComposerDraftCoordinator();
    const draft = { text: "current", attachments: [] };

    syncDraft(coordinator, "agent-a", draft);
    startAttempt(coordinator, "agent-a", draft);
    expect(
      coordinator.beginQueuedAction({
        ownerId: "agent-a",
        currentDraft: draft,
        messageId: "queued-1",
        action: "edit",
      }),
    ).toBe(false);

    coordinator.settleDraftAttempt({
      ownerId: "agent-a",
      attemptId: 1,
      outcome: "accepted",
    });
    expect(
      coordinator.beginQueuedAction({
        ownerId: "agent-a",
        currentDraft: draft,
        messageId: "queued-1",
        action: "edit",
      }),
    ).toBe(true);
    expect(startAttempt(coordinator, "agent-a", draft)).toBeNull();
    expect(
      coordinator.beginQueuedAction({
        ownerId: "agent-a",
        currentDraft: draft,
        messageId: "queued-2",
        action: "send",
      }),
    ).toBe(false);
  });
});
