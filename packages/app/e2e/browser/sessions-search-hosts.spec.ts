import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openSessions } from "../support/helpers/archive-tab";
import { createIdleAgent } from "../support/helpers/archive-tab";
import { addConnectedHostAndReload, addOfflineHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { connectSeedClient, seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
// The constants module is plain TypeScript, so the Playwright runner can import
// it — reaching through the `.tsx` picker would drag React Native into Node.
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker-constants";

const AGENT_ROW = '[data-testid^="agent-row-"]';
const PRIMARY_LABEL = "Primary box";
const SECONDARY_LABEL = "Secondary box";

/** Scopes every assertion to this spec's sessions on a shared daemon. */
const NONCE = `hsx${randomUUID().replaceAll("-", "").slice(0, 8)}`;

async function search(page: Page, query: string): Promise<void> {
  await page.getByTestId("sessions-search-input").fill(query);
}

async function selectHost(page: Page, serverId: string): Promise<void> {
  await page.getByTestId("sessions-host-filter-trigger").click();
  await page.getByTestId(`sessions-host-filter-item-${serverId}`).click();
}

async function expectRankedTitles(page: Page, titles: string[]): Promise<void> {
  const rows = page.locator(AGENT_ROW).filter({ hasText: NONCE });
  await expect(rows).toHaveCount(titles.length, { timeout: 30_000 });
  for (const [index, title] of titles.entries()) {
    await expect(rows.nth(index)).toContainText(title, { timeout: 30_000 });
  }
}

// Searching across hosts is the case a single-daemon spec cannot see: each host
// ranks only its own sessions, so the merge is the only thing that can put the
// best match first.
test.describe("History search across hosts", () => {
  test.describe.configure({ timeout: 420_000 });

  test("ranks matches from every host together and narrows to one host on demand", async ({
    page,
  }) => {
    const secondaryServerId = `srv_hist_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const secondaryDaemon = await startIsolatedHostDaemon(secondaryServerId);
    const primaryClient = await connectSeedClient();
    let primaryWorkspace: Awaited<ReturnType<typeof seedWorkspace>> | null = null;
    let secondaryWorkspace: Awaited<ReturnType<typeof seedWorkspace>> | null = null;

    // The weak match is the newest session on the primary host and the strong
    // match is the oldest on the secondary, so only a real cross-host merge on
    // relevance can order them correctly.
    const weakTitle = `${NONCE} Unbilled usage report`;
    const strongTitle = `${NONCE} Bill the customer`;
    const unrelatedTitle = `${NONCE} Terminal resize fix`;

    try {
      secondaryWorkspace = await seedWorkspace({
        repoPrefix: "sessions-search-secondary-",
        port: secondaryDaemon.port,
      });
      await createIdleAgent(secondaryWorkspace.client, {
        cwd: secondaryWorkspace.repoPath,
        workspaceId: secondaryWorkspace.workspaceId,
        title: strongTitle,
      });

      primaryWorkspace = await seedWorkspace({ repoPrefix: "sessions-search-primary-" });
      for (const title of [unrelatedTitle, weakTitle]) {
        await createIdleAgent(primaryClient, {
          cwd: primaryWorkspace.repoPath,
          workspaceId: primaryWorkspace.workspaceId,
          title,
        });
      }

      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryDaemon.serverId,
        label: SECONDARY_LABEL,
        port: secondaryDaemon.port,
        primaryLabel: PRIMARY_LABEL,
      });
      await openSessions(page);

      // All hosts: the stronger match leads despite being the older session on
      // the other daemon.
      await search(page, `${NONCE} bill`);
      await expectRankedTitles(page, [strongTitle, weakTitle]);

      // One host: the other daemon's stronger match drops out entirely.
      await selectHost(page, getServerId());
      await expectRankedTitles(page, [weakTitle]);

      await selectHost(page, secondaryDaemon.serverId);
      await expectRankedTitles(page, [strongTitle]);

      // Back to all hosts, and clearing the query returns every seeded session.
      await selectHost(page, ALL_HOSTS_OPTION_ID);
      await page.getByTestId("sessions-search-clear").click();
      const rows = page.locator(AGENT_ROW).filter({ hasText: NONCE });
      await expect(rows).toHaveCount(3, { timeout: 30_000 });
    } finally {
      await primaryWorkspace?.cleanup().catch(() => undefined);
      await secondaryWorkspace?.cleanup().catch(() => undefined);
      await primaryClient.close().catch(() => undefined);
      await secondaryDaemon.close().catch(() => undefined);
    }
  });

  test("names a host it could not reach instead of shrinking the results silently", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sessions-search-offline-" });
    const reachableTitle = `${NONCE} Bill the reachable customer`;

    try {
      await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: reachableTitle,
      });

      await gotoAppShell(page);
      await addOfflineHostAndReload(page, {
        serverId: "sessions-search-unreachable",
        label: SECONDARY_LABEL,
        primaryLabel: PRIMARY_LABEL,
      });
      await openSessions(page);

      // The unreachable host's sessions were never searched. Reporting only the
      // matches that were found, with no word about the host that never
      // answered, is the failure this asserts against.
      await search(page, `${NONCE} bill`);
      await expect(page.getByTestId("sessions-host-errors")).toContainText(SECONDARY_LABEL, {
        timeout: 30_000,
      });
      await expectRankedTitles(page, [reachableTitle]);
    } finally {
      await workspace.cleanup().catch(() => undefined);
    }
  });
});
