import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  createIdleAgent,
  openSessions,
  resetSeededPageState,
} from "../support/helpers/archive-tab";

/**
 * Every seeded title opens with the same nonce, so a query of "<nonce> term"
 * can only reach this spec's sessions. The daemon is shared with the rest of
 * the browser suite and its history is whatever those specs left behind.
 */
const NONCE = `hsq${randomUUID().replaceAll("-", "").slice(0, 8)}`;

const TITLES = {
  billing: `${NONCE} main Add Stripe billing`,
  unbilled: `${NONCE} main Unbilled usage report`,
  terminal: `${NONCE} main Terminal resize fix`,
} as const;

async function search(page: Page, query: string): Promise<void> {
  await page.getByTestId("sessions-search-input").fill(query);
}

function rowTitles(page: Page) {
  return page.getByRole("button");
}

async function expectVisibleTitles(page: Page, titles: string[]): Promise<void> {
  const rows = rowTitles(page).filter({ hasText: NONCE });
  await expect(rows).toHaveCount(titles.length, { timeout: 30_000 });
  for (const [index, title] of titles.entries()) {
    await expect(rows.nth(index)).toContainText(title, { timeout: 30_000 });
  }
}

async function verifyChronologicalFiltering(page: Page): Promise<void> {
  await test.step("narrows history while preserving chronological grouping", async () => {
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing, TITLES.terminal]);
    await expect(page.getByText("Today", { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });

    await search(page, `${NONCE} billing`);
    await expectVisibleTitles(page, [TITLES.billing]);
    await expect(page.getByText("Today", { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });

    await page.getByTestId("sessions-search-clear").click();
    await expect(page.getByTestId("sessions-search-input")).toHaveValue("");
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing, TITLES.terminal]);
    await expect(page.getByText("Today", { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });
  });
}

async function verifyRecencyBeforeMatchStrength(page: Page): Promise<void> {
  await test.step("keeps newer partial matches before older stronger matches", async () => {
    await search(page, `${NONCE} bill`);
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing]);
  });
}

async function verifyExactAndTypoHighlights(page: Page): Promise<void> {
  await test.step("highlights exact and typo-resolved matches", async () => {
    await search(page, `${NONCE} billing`);
    const row = page.getByRole("button").filter({ hasText: NONCE }).first();
    await expect(row.getByText("billing", { exact: true })).toBeVisible({ timeout: 30_000 });

    await search(page, `${NONCE} bulling`);
    await expectVisibleTitles(page, [TITLES.billing]);
    const typoRow = page.getByRole("button").filter({ hasText: NONCE }).first();
    await expect(typoRow.getByText("billing", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });
}

async function verifyAllSearchFieldHighlights(page: Page): Promise<void> {
  await test.step("highlights workspace, agent, project and branch independently", async () => {
    await search(page, `${NONCE} main`);
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing, TITLES.terminal]);
    const row = rowTitles(page).filter({ hasText: NONCE }).first();
    for (const field of ["workspace", "title", "project", "branch"]) {
      await expect(
        row.getByTestId(new RegExp(`^agent-row-${field}-`)).getByText(/^main$/i),
      ).toBeVisible();
    }
    await expect(page.getByText("Yesterday", { exact: true })).toHaveCount(0);
  });
}

async function verifyEmptySearchAndRecovery(page: Page): Promise<void> {
  await test.step("distinguishes no matches from empty history", async () => {
    await search(page, `${NONCE} kubernetes`);
    await expect(page.getByTestId("sessions-empty")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No sessions match")).toBeVisible({ timeout: 30_000 });

    await page.getByText("Clear search").click();
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing, TITLES.terminal]);
  });
}

test.describe("History search", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("main-sessions-search-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
      title: "Main history",
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    const workspaceId = created.workspace.id;

    for (const title of [TITLES.terminal, TITLES.billing, TITLES.unbilled]) {
      await createIdleAgent(client, { cwd: tempRepo.path, workspaceId, title });
    }
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    test(`filters chronological history and highlights matches at ${viewport.width}px`, async ({
      page,
    }) => {
      await resetSeededPageState(page);
      await openSessions(page);
      await page.setViewportSize(viewport);

      await verifyChronologicalFiltering(page);

      await verifyRecencyBeforeMatchStrength(page);

      await verifyExactAndTypoHighlights(page);

      await verifyAllSearchFieldHighlights(page);

      await verifyEmptySearchAndRecovery(page);
    });
  }
});
