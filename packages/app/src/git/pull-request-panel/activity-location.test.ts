import { describe, expect, it } from "vitest";
import { formatPullRequestActivityLocation } from "./activity-location";
import type { PrPaneActivity } from "./data";

function activity(location: PrPaneActivity["location"]): PrPaneActivity {
  return {
    id: "comment-1",
    provider: "github",
    kind: "comment",
    author: "octocat",
    avatarColor: "#0ea5e9",
    body: "Looks good.",
    age: "3d ago",
    url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
    location,
  };
}

describe("pull request activity location labels", () => {
  it("includes inline thread state and concise thread IDs", () => {
    expect(
      formatPullRequestActivityLocation(
        activity({
          path: "packages/app/src/panel.tsx",
          startLine: 10,
          line: 12,
          threadId: "PRRT_1",
          isResolved: false,
          isOutdated: true,
        }),
      ),
    ).toBe("packages/app/src/panel.tsx:10-12 · unresolved · outdated · thread PRRT_1");
  });

  it("includes current/resolved state without noisy long thread IDs", () => {
    expect(
      formatPullRequestActivityLocation(
        activity({
          path: "packages/app/src/panel.tsx",
          line: 12,
          threadId: "PRRT_kwDOAReallyLongOpaqueThreadIdentifier",
          isResolved: true,
          isOutdated: false,
        }),
      ),
    ).toBe("packages/app/src/panel.tsx:12 · resolved · current");
  });
});
