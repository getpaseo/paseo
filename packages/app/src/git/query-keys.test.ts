import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  checkoutCommitsQueryKey,
  checkoutDiffQueryKey,
  checkoutPrStatusQueryKey,
  checkoutStatusQueryKey,
  invalidateCheckoutGitQueriesForClient,
  invalidateCheckoutGitQueriesForServer,
} from "@/git/query-keys";
import {
  prPanePipelineQueryKey,
  prPaneTimelineQueryKey,
} from "@/git/pull-request-panel/query-keys";

describe("checkout query keys", () => {
  const serverId = "server-1";
  const target = {
    workspaceId: "workspace-a",
    cwd: "/tmp/repo",
    queryIdentity: ["selected", "workspace-a"] as const,
  };
  const sibling = {
    workspaceId: "workspace-b",
    cwd: target.cwd,
    queryIdentity: ["selected", "workspace-b"] as const,
  };

  it("uses workspace identity before the compatibility cwd", () => {
    expect(checkoutStatusQueryKey(serverId, target)).toEqual([
      "checkoutStatus",
      serverId,
      target.queryIdentity,
      target.cwd,
    ]);
    expect(checkoutStatusQueryKey(serverId, sibling)).not.toEqual(
      checkoutStatusQueryKey(serverId, target),
    );
  });

  it("keeps selected and legacy identity distinct across keys and invalidation", async () => {
    const selected = {
      ...target,
      workspaceId: "legacy:/shared",
      cwd: "/shared",
      queryIdentity: ["selected", "legacy:/shared"] as const,
    };
    const legacy = {
      cwd: "/shared",
      queryIdentity: ["legacy", "/shared"] as const,
    };

    expect(checkoutStatusQueryKey(serverId, selected)).not.toEqual(
      checkoutStatusQueryKey(serverId, legacy),
    );
    expect(checkoutPrStatusQueryKey(serverId, selected)).not.toEqual(
      checkoutPrStatusQueryKey(serverId, legacy),
    );
    expect(checkoutDiffQueryKey(serverId, selected, "uncommitted")).toContainEqual(
      selected.queryIdentity,
    );
    expect(checkoutCommitsQueryKey(serverId, selected)).toContainEqual(selected.queryIdentity);

    const queryClient = new QueryClient();
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, selected), { branch: "selected" });
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, legacy), { branch: "legacy" });
    queryClient.setQueryData(checkoutPrStatusQueryKey(serverId, selected), { status: "selected" });
    queryClient.setQueryData(checkoutPrStatusQueryKey(serverId, legacy), { status: "legacy" });
    queryClient.setQueryData(checkoutDiffQueryKey(serverId, selected, "uncommitted"), {
      files: ["selected"],
    });
    queryClient.setQueryData(checkoutCommitsQueryKey(serverId, selected), {
      commits: ["selected"],
    });

    await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, target: selected });

    expect(
      queryClient.getQueryState(checkoutStatusQueryKey(serverId, selected))?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(checkoutStatusQueryKey(serverId, legacy))?.isInvalidated).toBe(
      false,
    );
    expect(
      queryClient.getQueryState(checkoutPrStatusQueryKey(serverId, selected))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(checkoutPrStatusQueryKey(serverId, legacy))?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(checkoutDiffQueryKey(serverId, selected, "uncommitted"))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(checkoutCommitsQueryKey(serverId, selected))?.isInvalidated,
    ).toBe(true);
  });

  it("invalidates one selected workspace without touching a same-cwd sibling", async () => {
    const queryClient = new QueryClient();
    for (const selected of [target, sibling]) {
      queryClient.setQueryData(checkoutStatusQueryKey(serverId, selected), { isGit: true });
      queryClient.setQueryData(checkoutDiffQueryKey(serverId, selected, "base", "main", true), {
        files: [],
      });
      queryClient.setQueryData(checkoutPrStatusQueryKey(serverId, selected), { status: null });
      queryClient.setQueryData(checkoutCommitsQueryKey(serverId, selected), { commits: [] });
      queryClient.setQueryData(prPaneTimelineQueryKey({ serverId, ...selected, prNumber: 12 }), {
        items: [],
      });
      queryClient.setQueryData(
        prPanePipelineQueryKey({ serverId, ...selected, pipelineId: 9, changeRequestNumber: 12 }),
        { stages: [] },
      );
    }

    await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, target });

    expect(queryClient.getQueryState(checkoutStatusQueryKey(serverId, target))?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(checkoutDiffQueryKey(serverId, target, "base", "main", true))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(checkoutPrStatusQueryKey(serverId, target))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(checkoutCommitsQueryKey(serverId, target))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(prPaneTimelineQueryKey({ serverId, ...target, prNumber: 12 }))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        prPanePipelineQueryKey({ serverId, ...target, pipelineId: 9, changeRequestNumber: 12 }),
      )?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(checkoutStatusQueryKey(serverId, sibling))?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(checkoutCommitsQueryKey(serverId, sibling))?.isInvalidated,
    ).toBe(false);
  });

  it("invalidates fetch-based selected queries server-wide but leaves diffs subscription-fed", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, target), { isGit: true });
    queryClient.setQueryData(checkoutDiffQueryKey(serverId, target, "base", "main", true), {
      files: [],
    });
    queryClient.setQueryData(checkoutStatusQueryKey("server-2", target), { isGit: true });

    await invalidateCheckoutGitQueriesForServer(queryClient, serverId);

    expect(queryClient.getQueryState(checkoutStatusQueryKey(serverId, target))?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(checkoutDiffQueryKey(serverId, target, "base", "main", true))
        ?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(checkoutStatusQueryKey("server-2", target))?.isInvalidated,
    ).toBe(false);
  });
});
