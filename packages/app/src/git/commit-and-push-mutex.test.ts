import { describe, expect, it } from "vitest";
import { computeCommitAndPushMutex } from "@/git/commit-and-push-mutex";

describe("computeCommitAndPushMutex", () => {
  const idleStatuses = Array.from({ length: 14 }, () => "idle" as const);

  it("disables other checkout actions while commit-and-push is pending", () => {
    const result = computeCommitAndPushMutex({
      actionsDisabled: false,
      commitAndPushStatus: "pending",
      otherStatuses: idleStatuses,
      isArchiving: false,
    });

    expect(result.otherActionsDisabled).toBe(true);
    expect(result.isOtherMutationPending).toBe(false);
  });

  it("disables commit-and-push while any other checkout mutation is pending", () => {
    const result = computeCommitAndPushMutex({
      actionsDisabled: false,
      commitAndPushStatus: "idle",
      otherStatuses: [...idleStatuses.slice(1), "pending"],
      isArchiving: false,
    });

    expect(result.otherActionsDisabled).toBe(false);
    expect(result.isOtherMutationPending).toBe(true);
  });

  it("disables commit-and-push while the workspace is archiving", () => {
    const result = computeCommitAndPushMutex({
      actionsDisabled: false,
      commitAndPushStatus: "idle",
      otherStatuses: idleStatuses,
      isArchiving: true,
    });

    expect(result.isOtherMutationPending).toBe(true);
  });

  it("blocks neither direction when everything is idle", () => {
    const result = computeCommitAndPushMutex({
      actionsDisabled: false,
      commitAndPushStatus: "idle",
      otherStatuses: idleStatuses,
      isArchiving: false,
    });

    expect(result.otherActionsDisabled).toBe(false);
    expect(result.isOtherMutationPending).toBe(false);
  });
});
