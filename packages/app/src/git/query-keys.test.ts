import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  checkoutDiffQueryKey,
  checkoutPrStatusQueryKey,
  checkoutStatusQueryKey,
  invalidateCheckoutGitQueriesForClient,
  invalidateCheckoutGitQueriesForServer,
} from "@/git/query-keys";
import { prPaneTimelineQueryKey } from "@/git/pull-request-panel/query-keys";

describe("checkout query keys", () => {
  const serverId = "server-1";
  const cwd = "/tmp/repo";

  it("invalidates every query for a checkout without touching other checkouts", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), { isGit: true });
    queryClient.setQueryData(checkoutDiffQueryKey(serverId, cwd, "base", "main", true), {
      files: [],
    });
    queryClient.setQueryData(checkoutPrStatusQueryKey(serverId, cwd), { status: { number: 12 } });
    queryClient.setQueryData(prPaneTimelineQueryKey({ serverId, cwd, prNumber: 12 }), {
      items: [],
    });
    queryClient.setQueryData(prPaneTimelineQueryKey({ serverId, cwd, prNumber: 13 }), {
      items: [],
    });
    queryClient.setQueryData(
      prPaneTimelineQueryKey({ serverId, cwd: "/tmp/other", prNumber: 12 }),
      { items: [] },
    );

    await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });

    expect(queryClient.getQueryState(checkoutStatusQueryKey(serverId, cwd))?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(checkoutDiffQueryKey(serverId, cwd, "base", "main", true))
        ?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(checkoutPrStatusQueryKey(serverId, cwd))?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(prPaneTimelineQueryKey({ serverId, cwd, prNumber: 12 }))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(prPaneTimelineQueryKey({ serverId, cwd, prNumber: 13 }))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        prPaneTimelineQueryKey({ serverId, cwd: "/tmp/other", prNumber: 12 }),
      )?.isInvalidated,
    ).toBe(false);

    queryClient.clear();
  });

  it("invalidates fetch-based checkout queries server-wide without touching other servers", async () => {
    const queryClient = new QueryClient();
    const otherServerId = "server-2";
    const otherCwd = "/tmp/repo-2";

    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), { isGit: true });
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, otherCwd), { isGit: true });
    queryClient.setQueryData(checkoutPrStatusQueryKey(serverId, cwd), { status: { number: 12 } });
    queryClient.setQueryData(prPaneTimelineQueryKey({ serverId, cwd, prNumber: 12 }), {
      items: [],
    });
    // Subscription-fed diff queries are deliberately not part of the server-wide sweep.
    queryClient.setQueryData(checkoutDiffQueryKey(serverId, cwd, "base", "main", true), {
      files: [],
    });
    queryClient.setQueryData(checkoutStatusQueryKey(otherServerId, cwd), { isGit: true });

    await invalidateCheckoutGitQueriesForServer(queryClient, serverId);

    expect(queryClient.getQueryState(checkoutStatusQueryKey(serverId, cwd))?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(checkoutStatusQueryKey(serverId, otherCwd))?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(checkoutPrStatusQueryKey(serverId, cwd))?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(prPaneTimelineQueryKey({ serverId, cwd, prNumber: 12 }))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(checkoutDiffQueryKey(serverId, cwd, "base", "main", true))
        ?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(checkoutStatusQueryKey(otherServerId, cwd))?.isInvalidated,
    ).toBe(false);

    queryClient.clear();
  });
});
