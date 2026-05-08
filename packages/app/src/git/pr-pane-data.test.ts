import { describe, expect, it } from "vitest";
import type {
  CheckoutPrStatusResponse,
  PullRequestTimelineResponse,
} from "@server/shared/messages";
import {
  deriveAvatarColor,
  formatAge,
  getActivityVerb,
  getStateLabel,
  mapPrPaneData,
} from "./pr-pane-data";

type CheckoutPrStatus = NonNullable<CheckoutPrStatusResponse["payload"]["status"]>;
type PullRequestTimeline = PullRequestTimelineResponse["payload"];

const baseStatus: CheckoutPrStatus = {
  number: 42,
  url: "https://github.com/getpaseo/paseo/pull/42",
  title: "Wire PR pane data",
  state: "open",
  baseRefName: "main",
  headRefName: "feature/pr-pane",
  isMerged: false,
  isDraft: false,
  mergeable: "UNKNOWN",
  checks: [],
  reviewDecision: null,
};

const baseTimeline: PullRequestTimeline = {
  cwd: "/repo",
  prNumber: 42,
  items: [],
  truncated: false,
  error: null,
  requestId: "timeline-1",
  githubFeaturesEnabled: true,
};

function status(overrides: Partial<CheckoutPrStatus> = {}): CheckoutPrStatus {
  return { ...baseStatus, ...overrides };
}

function timeline(overrides: Partial<PullRequestTimeline> = {}): PullRequestTimeline {
  return { ...baseTimeline, ...overrides };
}

describe("mapPrPaneData", () => {
  it("returns null when no PR status exists", () => {
    expect(mapPrPaneData(null, baseTimeline)).toBeNull();
  });

  it("derives the PR number from the status URL when the status number is absent", () => {
    const data = mapPrPaneData(
      status({
        number: undefined,
        url: "https://github.com/getpaseo/paseo/pull/1284",
      }),
      timeline({ prNumber: 1284 }),
    );

    expect(data?.number).toBe(1284);
  });

  it("returns null when status has no number and no parseable PR URL", () => {
    expect(
      mapPrPaneData(status({ number: undefined, url: "https://github.com/getpaseo/paseo" }), null),
    ).toBeNull();
  });

  it("derives PR state with merged taking precedence over closed, draft, and open", () => {
    expect(
      mapPrPaneData(status({ isMerged: true, isDraft: true, state: "closed" }), baseTimeline)
        ?.state,
    ).toBe("merged");
    expect(
      mapPrPaneData(status({ isMerged: false, isDraft: true, state: "closed" }), baseTimeline)
        ?.state,
    ).toBe("closed");
    expect(mapPrPaneData(status({ isDraft: true, state: "open" }), baseTimeline)?.state).toBe(
      "draft",
    );
    expect(mapPrPaneData(status({ isDraft: false, state: "open" }), baseTimeline)?.state).toBe(
      "open",
    );
  });

  it("drops checks with null URLs to preserve the pressable check contract", () => {
    const data = mapPrPaneData(
      status({
        checks: [
          { name: "typecheck", status: "success", url: "https://example.com/checks/1" },
          { name: "legacy status", status: "pending", url: null },
        ],
      }),
      baseTimeline,
    );

    expect(data?.checks).toEqual([
      {
        name: "typecheck",
        status: "success",
        url: "https://example.com/checks/1",
      },
    ]);
  });

  it("maps server check statuses into the frozen check status union", () => {
    const data = mapPrPaneData(
      status({
        checks: [
          {
            name: "success",
            status: "success",
            url: "https://example.com/1",
            workflow: "CI",
            duration: "1m",
          },
          { name: "failure", status: "failure", url: "https://example.com/2" },
          { name: "pending", status: "pending", url: "https://example.com/3" },
          { name: "skipped", status: "skipped", url: "https://example.com/4" },
          { name: "cancelled", status: "cancelled", url: "https://example.com/5" },
        ],
      }),
      baseTimeline,
    );

    expect(data?.checks).toEqual([
      {
        name: "success",
        workflow: "CI",
        status: "success",
        duration: "1m",
        url: "https://example.com/1",
      },
      { name: "failure", status: "failure", url: "https://example.com/2" },
      { name: "pending", status: "pending", url: "https://example.com/3" },
      { name: "skipped", status: "skipped", url: "https://example.com/4" },
      { name: "cancelled", status: "skipped", url: "https://example.com/5" },
    ]);
  });

  it("preserves timeline item order while mapping mixed reviews and comments", () => {
    const data = mapPrPaneData(
      baseStatus,
      timeline({
        items: [
          {
            id: "review-1",
            kind: "review",
            author: "alice",
            reviewState: "approved",
            body: "Looks good.",
            createdAt: Date.UTC(2026, 0, 1, 10, 0, 0),
            url: "https://example.com/review-1",
          },
          {
            id: "comment-1",
            kind: "comment",
            author: "bob",
            body: "One thought.",
            createdAt: Date.UTC(2026, 0, 1, 11, 0, 0),
            url: "https://example.com/comment-1",
          },
        ],
      }),
      Date.UTC(2026, 0, 1, 12, 0, 0),
    );

    expect(data?.activity.map((item) => item.kind)).toEqual(["review", "comment"]);
    expect(data?.activity.map((item) => item.author)).toEqual(["alice", "bob"]);
  });

  it("filters empty commented reviews but keeps blocking review states", () => {
    const data = mapPrPaneData(
      baseStatus,
      timeline({
        items: [
          {
            id: "commented-empty",
            kind: "review",
            author: "alice",
            reviewState: "commented",
            body: "   ",
            createdAt: 1000,
            url: "https://example.com/commented-empty",
          },
          {
            id: "approved-empty",
            kind: "review",
            author: "bob",
            reviewState: "approved",
            body: "",
            createdAt: 2000,
            url: "https://example.com/approved-empty",
          },
          {
            id: "changes-empty",
            kind: "review",
            author: "cam",
            reviewState: "changes_requested",
            body: "",
            createdAt: 3000,
            url: "https://example.com/changes-empty",
          },
        ],
      }),
      4000,
    );

    expect(data?.activity).toMatchObject([
      { kind: "review", author: "bob", reviewState: "approved", body: "" },
      { kind: "review", author: "cam", reviewState: "changes_requested", body: "" },
    ]);
  });

  it("filters empty issue comments while preserving review activity with empty bodies", () => {
    const data = mapPrPaneData(
      baseStatus,
      timeline({
        items: [
          {
            id: "comment-empty",
            kind: "comment",
            author: "alice",
            body: "   ",
            createdAt: 1000,
            url: "https://example.com/comment-empty",
          },
          {
            id: "approved-empty",
            kind: "review",
            author: "bob",
            reviewState: "approved",
            body: "",
            createdAt: 2000,
            url: "https://example.com/approved-empty",
          },
          {
            id: "approved-body",
            kind: "review",
            author: "cam",
            reviewState: "approved",
            body: "Looks good.",
            createdAt: 3000,
            url: "https://example.com/approved-body",
          },
        ],
      }),
      4000,
    );

    expect(data?.activity).toMatchObject([
      { kind: "review", author: "bob", reviewState: "approved", body: "" },
      { kind: "review", author: "cam", reviewState: "approved", body: "Looks good." },
    ]);
  });

  it("maps review decisions into the frozen pending fallback contract", () => {
    expect(
      mapPrPaneData(status({ reviewDecision: "approved" }), baseTimeline)?.reviewDecision,
    ).toBe("approved");
    expect(
      mapPrPaneData(status({ reviewDecision: "changes_requested" }), baseTimeline)?.reviewDecision,
    ).toBe("changes_requested");
    expect(
      mapPrPaneData(status({ reviewDecision: "review_required" }), baseTimeline)?.reviewDecision,
    ).toBe("pending");
    expect(mapPrPaneData(status({ reviewDecision: null }), baseTimeline)?.reviewDecision).toBe(
      "pending",
    );
    expect(
      mapPrPaneData(
        status({ reviewDecision: undefined as CheckoutPrStatus["reviewDecision"] }),
        baseTimeline,
      )?.reviewDecision,
    ).toBe("pending");
    expect(
      mapPrPaneData(
        status({ reviewDecision: "surprising" as CheckoutPrStatus["reviewDecision"] }),
        baseTimeline,
      )?.reviewDecision,
    ).toBe("pending");
  });

  it("leaves awaiting reviewers intentionally unwired", () => {
    expect(mapPrPaneData(baseStatus, baseTimeline)?.awaitingReviewers).toEqual([]);
  });

  it("rejects stale timeline activity when the timeline PR number differs from status", () => {
    const data = mapPrPaneData(
      baseStatus,
      timeline({
        prNumber: 99,
        items: [
          {
            id: "comment-1",
            kind: "comment",
            author: "alice",
            body: "This belongs to another PR.",
            createdAt: 1000,
            url: "https://example.com/comment-1",
          },
        ],
      }),
      2000,
    );

    expect(data?.activity).toEqual([]);
  });
});

describe("deriveAvatarColor", () => {
  it("returns a deterministic color from the PR pane avatar palette", () => {
    const palette = [
      "#8b5cf6",
      "#f97316",
      "#0ea5e9",
      "#10b981",
      "#ef4444",
      "#eab308",
      "#ec4899",
      "#6366f1",
    ];

    expect(deriveAvatarColor("alice")).toBe(deriveAvatarColor("alice"));
    expect(palette).toContain(deriveAvatarColor("alice"));
    expect(palette).toContain(deriveAvatarColor("Alice"));
  });
});

describe("formatAge", () => {
  it("emits PR pane age labels", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);

    expect(formatAge(now - 20_000, now)).toBe("just now");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatAge(now - 2 * 60 * 60_000, now)).toBe("2h ago");
    expect(formatAge(now - 3 * 24 * 60 * 60_000, now)).toBe("3d ago");
    expect(formatAge(now - 90 * 24 * 60 * 60_000, now)).toBe("3mo ago");
    expect(formatAge(now - 365 * 24 * 60 * 60_000, now)).toBe("1y ago");
  });
});

describe("getStateLabel", () => {
  it.each([
    ["open", "Open"],
    ["draft", "Draft"],
    ["merged", "Merged"],
    ["closed", "Closed"],
  ] as const)("maps %s → %s", (state, expected) => {
    expect(getStateLabel(state)).toBe(expected);
  });
});

describe("getActivityVerb", () => {
  it("returns Commented for comment kind", () => {
    expect(getActivityVerb({ kind: "comment" })).toBe("Commented");
  });

  it("returns Approved for approved review", () => {
    expect(getActivityVerb({ kind: "review", reviewState: "approved" })).toBe("Approved");
  });

  it("returns Requested changes for changes_requested review", () => {
    expect(getActivityVerb({ kind: "review", reviewState: "changes_requested" })).toBe(
      "Requested changes",
    );
  });

  it("returns Reviewed for a commented review with body (generic case)", () => {
    expect(getActivityVerb({ kind: "review", reviewState: "commented" })).toBe("Reviewed");
  });

  it("returns Reviewed when reviewState is undefined", () => {
    expect(getActivityVerb({ kind: "review" })).toBe("Reviewed");
  });
});
