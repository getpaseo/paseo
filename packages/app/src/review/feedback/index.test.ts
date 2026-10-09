import { describe, expect, it } from "vitest";
import {
  createReviewFeedback,
  createReviewFeedbackScope,
  type ReviewFeedbackPorts,
  type ReviewFeedbackSnapshot,
  type FeedbackAttachment,
  type FeedbackRecipient,
} from "./index";
import type { ReviewDraftComment } from "../state";

function makeComment(id: string, body = id): ReviewDraftComment {
  return {
    id,
    body,
    filePath: "sample.ts",
    side: "new",
    lineNumber: 2,
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
  };
}
function makeRecipient(agentId: string): FeedbackRecipient {
  return {
    agentId,
    tab: {
      key: `agent_${agentId}`,
      tabId: `agent_${agentId}`,
      kind: "agent",
      target: { kind: "agent", agentId },
    },
  };
}
function makeAttachment(comments: readonly ReviewDraftComment[]): FeedbackAttachment | null {
  if (!comments.length) return null;
  const line = {
    type: "add" as const,
    content: "const value = 1",
    oldLineNumber: null,
    newLineNumber: 2,
  };
  return {
    kind: "review",
    reviewDraftKey: "draft",
    commentCount: comments.length,
    attachment: {
      type: "review",
      mimeType: "application/paseo-review",
      cwd: "/workspace",
      mode: "uncommitted",
      baseRef: null,
      comments: comments.map((comment) => ({
        filePath: comment.filePath,
        side: comment.side,
        lineNumber: comment.lineNumber,
        body: comment.body,
        context: { hunkHeader: "@@ -1 +1 @@", targetLine: line, lines: [line] },
      })),
    },
  };
}
function setup(agentIds: string[], unavailableIds: string[] = [], create = createReviewFeedback) {
  let comments = [makeComment("first")];
  let recipients = agentIds.map(makeRecipient);
  let connected = true;
  let rejectSend: ((error: Error) => void) | null = null;
  let resolveSend: (() => void) | null = null;
  const sends: Array<{ recipient: FeedbackRecipient; attachment: FeedbackAttachment }> = [];
  const read = (): ReviewFeedbackSnapshot => ({
    comments,
    recipients,
    connected,
    attachment: makeAttachment(comments.filter((comment) => !unavailableIds.includes(comment.id))),
  });
  const ports: ReviewFeedbackPorts = {
    read,
    send: (recipient, attachment) => {
      sends.push({ recipient, attachment });
      return new Promise<void>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
    },
    clearSent: (sent) => {
      comments = comments.filter(
        (current) =>
          !sent.some(
            (prior) =>
              prior.id === current.id &&
              prior.updatedAt === current.updatedAt &&
              prior.body === current.body,
          ),
      );
    },
    failedMessage: () => "Failed to send",
  };
  const model = create(ports);
  return {
    model,
    ports,
    sends,
    comments: () => comments,
    setComments: (next: ReviewDraftComment[]) => {
      comments = next;
      model.refresh();
    },
    setRecipients: (ids: string[]) => {
      recipients = ids.map(makeRecipient);
      model.refresh();
    },
    disconnect: () => {
      connected = false;
      model.refresh();
    },
    succeed: () => resolveSend!(),
    fail: () => rejectSend!(new Error("Host rejected feedback")),
  };
}

describe("review feedback", () => {
  it("counts only attached comments, freezes the sending count, and retains orphans", async () => {
    const feedback = setup(["one"], ["orphan"]);
    feedback.setComments([makeComment("first"), makeComment("orphan")]);
    expect(feedback.model.getState()).toMatchObject({ commentCount: 2, sendableCommentCount: 1 });
    const pending = feedback.model.press();
    feedback.setComments([makeComment("first"), makeComment("orphan"), makeComment("added")]);
    expect(feedback.model.getState()).toMatchObject({
      phase: { kind: "sending", commentCount: 1 },
      sendableCommentCount: 2,
    });
    expect(feedback.sends[0]!.attachment.commentCount).toBe(1);
    feedback.succeed();
    await pending;
    expect(feedback.comments()).toEqual([makeComment("orphan"), makeComment("added")]);
  });
  it("retains an entirely orphaned draft without claiming any comments are sendable", async () => {
    const feedback = setup(["one"], ["first"]);
    expect(feedback.model.getState()).toMatchObject({
      commentCount: 1,
      sendableCommentCount: 0,
      disabledReason: "no-context",
      canSend: false,
    });
    await feedback.model.press();
    expect(feedback.sends).toEqual([]);
    expect(feedback.comments()).toEqual([makeComment("first")]);
  });
  it("retains comments and explains why no workspace agent can receive them", async () => {
    const feedback = setup([]);
    await feedback.model.press();
    expect(feedback.model.getState()).toMatchObject({
      canSend: false,
      disabledReason: "no-agents",
      commentCount: 1,
    });
    expect(feedback.sends).toEqual([]);
    expect(feedback.comments()).toEqual([makeComment("first")]);
  });
  it("sends once to the only recipient and clears only sent versions", async () => {
    const feedback = setup(["one"]);
    const pending = feedback.model.press();
    await feedback.model.press();
    await feedback.model.send("one");
    expect(feedback.sends).toEqual([
      { recipient: makeRecipient("one"), attachment: makeAttachment([makeComment("first")]) },
    ]);
    feedback.setComments([makeComment("first", "Edited during send"), makeComment("added")]);
    feedback.succeed();
    await pending;
    expect(feedback.comments()).toEqual([
      makeComment("first", "Edited during send"),
      makeComment("added"),
    ]);
    expect(feedback.model.getState().phase).toEqual({
      kind: "sent",
      recipient: makeRecipient("one"),
    });
  });
  it("clears unchanged sent comments while preserving additions", async () => {
    const feedback = setup(["one"]);
    const pending = feedback.model.press();
    feedback.setComments([makeComment("first"), makeComment("added")]);
    feedback.succeed();
    await pending;
    expect(feedback.comments()).toEqual([makeComment("added")]);
  });
  it("asks for a recipient when several tabs exist and validates the selection again", async () => {
    const feedback = setup(["one", "two"]);
    await feedback.model.press();
    expect(feedback.model.getState().phase).toEqual({ kind: "choosing" });
    expect(feedback.sends).toEqual([]);
    feedback.setRecipients(["one"]);
    await feedback.model.send("two");
    expect(feedback.sends).toEqual([]);
    const pending = feedback.model.send("one");
    feedback.succeed();
    await pending;
    expect(feedback.comments()).toEqual([]);
  });
  it("retains comments on failure and retries using the latest saved version", async () => {
    const feedback = setup(["one"]);
    const failed = feedback.model.press();
    feedback.fail();
    await failed;
    expect(feedback.model.getState().phase).toEqual({
      kind: "failed",
      message: "Host rejected feedback",
    });
    expect(feedback.comments()).toEqual([makeComment("first")]);
    feedback.setComments([makeComment("first", "Corrected before retry")]);
    const retried = feedback.model.press();
    feedback.succeed();
    await retried;
    expect(feedback.sends).toHaveLength(2);
    expect(feedback.sends[1]!.attachment.attachment.comments[0]!.body).toBe(
      "Corrected before retry",
    );
    expect(feedback.comments()).toEqual([]);
  });
  it("keeps workspace drafts independent and prevents disconnected sends", async () => {
    const first = setup(["one"]);
    const second = setup(["other"]);
    first.disconnect();
    await first.model.press();
    expect(first.model.getState().disabledReason).toBe("disconnected");
    const pending = second.model.press();
    second.succeed();
    await pending;
    expect(first.comments()).toEqual([makeComment("first")]);
    expect(first.sends).toEqual([]);
    expect(second.comments()).toEqual([]);
  });
});

describe("shared review submission ownership", () => {
  it("blocks another surface and reconnects to the pending draft while other drafts remain usable", async () => {
    const scope = createReviewFeedbackScope();
    const first = setup(["one"], [], (ports) => scope.connect("workspace-one", ports));
    const second = scope.connect("workspace-one", first.ports);
    const other = setup(["other"], [], (ports) => scope.connect("workspace-other", ports));
    const unsubscribe = first.model.subscribe(() => {});
    const pending = first.model.press();
    unsubscribe();
    await Promise.resolve();
    const reconnected = scope.connect("workspace-one", first.ports);
    expect(second.getState()).toMatchObject({ canSend: false, phase: { kind: "sending" } });
    await second.press();
    await reconnected.send("one");
    expect(first.sends).toHaveLength(1);
    const otherPending = other.model.press();
    expect(other.sends).toHaveLength(1);
    first.fail();
    await pending;
    expect(second.getState().phase).toEqual({ kind: "failed", message: "Host rejected feedback" });
    const retry = second.press();
    first.succeed();
    await retry;
    expect(first.sends).toHaveLength(2);
    other.succeed();
    await otherPending;
  });
  it("opens only the active surface's recipient chooser", async () => {
    const scope = createReviewFeedbackScope();
    const first = setup(["one", "two"], [], (ports) => scope.connect("same", ports));
    const second = scope.connect("same", first.ports);
    await first.model.press();
    expect(first.model.getState().phase).toEqual({ kind: "choosing" });
    expect(second.getState().phase).toEqual({ kind: "idle" });
    first.model.closeMenu();
    expect(first.model.getState().phase).toEqual({ kind: "idle" });
  });
});
