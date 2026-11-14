import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dialog, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { getServerId } from "../support/helpers/server-id";
import {
  clickArchiveWorkspaceMenuItem,
  expectWorkspaceAbsentFromSidebar,
} from "../support/helpers/sidebar";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  rowArchiveButton,
  undoButton,
  workspaceRow,
} from "../support/helpers/workspace-archive-undo";
import {
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

type DaemonClient = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

async function seedRiskyWorktree(client: DaemonClient, worktreeDirectory: string): Promise<void> {
  // The daemon only reports unpushed commits when the branch has a configured
  // upstream (aheadOfOrigin is computed against `branch.<name>.merge`). Push the
  // worktree branch at its current head first so it tracks origin with 0 ahead,
  // then add the local commit below that becomes the single unpushed commit.
  const branch = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: worktreeDirectory,
    stdio: "pipe",
  })
    .toString()
    .trim();
  execSync(`git push -u origin ${JSON.stringify(branch)}`, {
    cwd: worktreeDirectory,
    stdio: "ignore",
  });

  const committedFile = path.join(worktreeDirectory, "UNPUSHED.md");
  await writeFile(committedFile, "# unpushed\n");
  execSync(`git add ${JSON.stringify(path.basename(committedFile))}`, {
    cwd: worktreeDirectory,
    stdio: "ignore",
  });
  execSync('git commit -m "Add unpushed change"', {
    cwd: worktreeDirectory,
    stdio: "ignore",
  });

  const dirtyFile = path.join(worktreeDirectory, "DIRTY.md");
  await writeFile(dirtyFile, "# dirty\n");

  await refreshCheckout(client, worktreeDirectory);
}

async function refreshCheckout(client: DaemonClient, directory: string): Promise<void> {
  const refreshed = await client.checkoutRefresh(directory);
  if (!refreshed.success) {
    throw new Error(`Failed to refresh checkout for ${directory}`);
  }
}

// The archive confirmation is a synchronous web `window.confirm()` that opens once the app has
// read the worktree's git state from the host. Wait for the dialog itself: on web the click does
// not resolve until it is answered, so answer it from the event.
async function answerArchiveWarning(
  page: Page,
  answer: "accept" | "dismiss",
  openArchive: () => Promise<void>,
): Promise<Dialog> {
  const warning = page.waitForEvent("dialog", { timeout: 10_000 }).then(async (dialog) => {
    await (answer === "accept" ? dialog.accept() : dialog.dismiss());
    return dialog;
  });
  await openArchive();
  return await warning;
}

// A clean Paseo worktree's primary git action in the workspace header is Archive.
function gitActionsArchiveButton(page: Page) {
  return page.getByTestId("changes-primary-cta").and(page.getByLabel("Archive workspace"));
}

async function clickRowArchiveButton(page: Page, workspaceId: string): Promise<void> {
  await workspaceRow(page, workspaceId).hover();
  await rowArchiveButton(page, workspaceId).click();
}

interface SessionEnvelope {
  type?: unknown;
  message?: {
    type?: unknown;
    workspaceId?: unknown;
    cwd?: unknown;
    payload?: Record<string, unknown>;
  };
}

function parseSessionEnvelope(message: string): SessionEnvelope | null {
  try {
    return JSON.parse(message) as SessionEnvelope;
  } catch {
    return null;
  }
}

function removeGitStatusFromDescriptors(value: unknown, workspaceId: string): number {
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (count, item) => count + removeGitStatusFromDescriptors(item, workspaceId),
      0,
    );
  }
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  let count = 0;
  if (record.id === workspaceId && "workspaceDirectory" in record) {
    delete record.gitRuntime;
    record.diffStat = null;
    count += 1;
  }
  for (const child of Object.values(record)) {
    count += removeGitStatusFromDescriptors(child, workspaceId);
  }
  return count;
}

/**
 * Relays the app's connection to the daemon. Every workspace descriptor for `workspaceId` reaches
 * the app without git status, as the host sends it before its first checkout snapshot of the
 * worktree, so the sidebar row has nothing cached to warn from. `failCheckoutStatusFor` turns the
 * host's checkout status answer for that directory into a git error.
 */
async function relayDaemon(
  page: Page,
  input: { workspaceId: string; failCheckoutStatusFor?: string },
) {
  let descriptorRewrites = 0;
  let archiveRequests = 0;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      if (typeof message === "string") {
        const request = parseSessionEnvelope(message)?.message;
        if (
          request?.type === "archive_workspace_request" &&
          request.workspaceId === input.workspaceId
        ) {
          archiveRequests += 1;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message !== "string") {
        browser.send(message);
        return;
      }
      const envelope = parseSessionEnvelope(message);
      const response = envelope?.message;
      if (
        input.failCheckoutStatusFor &&
        response?.type === "checkout_status_response" &&
        response.payload?.cwd === input.failCheckoutStatusFor
      ) {
        response.payload = {
          ...response.payload,
          isGit: false,
          isPaseoOwnedWorktree: false,
          repoRoot: null,
          currentBranch: null,
          isDirty: null,
          baseRef: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
          error: { code: "UNKNOWN", message: "git status failed" },
        };
        browser.send(JSON.stringify(envelope));
        return;
      }
      if (!envelope || !message.includes(input.workspaceId)) {
        browser.send(message);
        return;
      }
      descriptorRewrites += removeGitStatusFromDescriptors(envelope, input.workspaceId);
      browser.send(JSON.stringify(envelope));
    });
  });
  return {
    descriptorRewrites: () => descriptorRewrites,
    archiveRequests: () => archiveRequests,
  };
}

/**
 * Holds the app's next checkout status request for `directory` once armed, so a test can act
 * while the archive waits for the host's answer.
 */
async function holdCheckoutStatusRequest(page: Page, directory: string) {
  let armed = false;
  let held: (() => void) | null = null;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const request = typeof message === "string" ? parseSessionEnvelope(message)?.message : null;
      if (
        armed &&
        !held &&
        request?.type === "checkout_status_request" &&
        request.cwd === directory
      ) {
        held = () => server.send(message);
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
  return {
    arm: () => {
      armed = true;
    },
    waitForHeld: () => expect.poll(() => held !== null).toBe(true),
    release: () => {
      if (!held) throw new Error("No checkout status request is held");
      held();
    },
  };
}

test.describe("Workspace archive risk warning for worktree backing", () => {
  let client: DaemonClient;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ retries: 1, timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-archive-risk-", { withRemote: true });
  });

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(client, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  async function createWorktree(slug: string) {
    const project = await openProjectViaDaemon(client, tempRepo.path);
    const worktree = await createWorktreeViaDaemon(client, {
      cwd: tempRepo.path,
      slug: `${slug}-${Date.now()}`,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);
    return { ...worktree, project };
  }

  async function openSidebarRow(page: Page, workspaceId: string): Promise<void> {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await waitForWorkspaceInSidebar(page, { serverId: getServerId(), workspaceId });
  }

  async function expectWorktreeKept(page: Page, worktree: { workspaceId: string }) {
    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible({ timeout: 10_000 });
  }

  async function hostListsWorkspace(workspaceId: string): Promise<boolean> {
    const { entries } = await client.fetchWorkspaces();
    return entries.some((entry) => entry.id === workspaceId);
  }

  test("a risky workspace archive is gated by confirmation and removes its worktree after acceptance", async ({
    page,
  }) => {
    const worktree = await createWorktree("archive-risk");
    await seedRiskyWorktree(client, worktree.workspaceDirectory);
    await openSidebarRow(page, worktree.workspaceId);

    const firstWarning = await answerArchiveWarning(page, "dismiss", () =>
      clickArchiveWorkspaceMenuItem(page, worktree.workspaceId),
    );
    expect(firstWarning.type()).toBe("confirm");
    expect(firstWarning.message()).toContain(`Archive "${worktree.workspaceName}"?`);
    expect(firstWarning.message()).toContain("Uncommitted changes");
    expect(firstWarning.message()).toContain("1 unpushed commit");

    await expectWorktreeKept(page, worktree);
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    const secondWarning = await answerArchiveWarning(page, "accept", () =>
      clickArchiveWorkspaceMenuItem(page, worktree.workspaceId),
    );
    expect(secondWarning.message()).toContain("Uncommitted changes");
    expect(secondWarning.message()).toContain("1 unpushed commit");

    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    createdWorktreeDirectories.delete(worktree.workspaceDirectory);
  });

  test("the row's archive button warns from the host's git state while the row has none, and Cancel keeps the worktree", async ({
    page,
  }) => {
    const worktree = await createWorktree("archive-risk-uncached");
    await seedRiskyWorktree(client, worktree.workspaceDirectory);
    const relay = await relayDaemon(page, { workspaceId: worktree.workspaceId });
    await openSidebarRow(page, worktree.workspaceId);
    expect(relay.descriptorRewrites()).toBeGreaterThan(0);

    const warning = await answerArchiveWarning(page, "dismiss", () =>
      clickRowArchiveButton(page, worktree.workspaceId),
    );
    expect(warning.message()).toContain(`Archive "${worktree.workspaceName}"?`);
    expect(warning.message()).toContain("Uncommitted changes");
    expect(warning.message()).toContain("1 unpushed commit");

    await expectWorktreeKept(page, worktree);
    expect(relay.archiveRequests()).toBe(0);
    expect(existsSync(path.join(worktree.workspaceDirectory, "DIRTY.md"))).toBe(true);
  });

  test("a worktree holding only new files warns when the repository hides untracked files", async ({
    page,
  }) => {
    execSync("git config status.showUntrackedFiles no", { cwd: tempRepo.path, stdio: "ignore" });
    const worktree = await createWorktree("archive-risk-untracked");
    await writeFile(path.join(worktree.workspaceDirectory, "NEW.md"), "# not yet added\n");
    await refreshCheckout(client, worktree.workspaceDirectory);
    await openSidebarRow(page, worktree.workspaceId);

    const warning = await answerArchiveWarning(page, "dismiss", () =>
      clickRowArchiveButton(page, worktree.workspaceId),
    );
    expect(warning.message()).toContain(`Archive "${worktree.workspaceName}"?`);
    expect(warning.message()).toContain("Uncommitted changes");

    await expectWorktreeKept(page, worktree);
    expect(existsSync(path.join(worktree.workspaceDirectory, "NEW.md"))).toBe(true);
  });

  test("a failed git read shows its error and keeps the worktree", async ({ page }) => {
    const worktree = await createWorktree("archive-risk-read-failure");
    await seedRiskyWorktree(client, worktree.workspaceDirectory);
    const relay = await relayDaemon(page, {
      workspaceId: worktree.workspaceId,
      failCheckoutStatusFor: worktree.workspaceDirectory,
    });
    await openSidebarRow(page, worktree.workspaceId);

    await clickRowArchiveButton(page, worktree.workspaceId);

    await expect(page.getByTestId("app-toast-message")).toHaveText("git status failed");
    await expectWorktreeKept(page, worktree);
    expect(relay.archiveRequests()).toBe(0);
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);
  });

  // Archives the open worktree with `startArchive`, opens the project's main workspace while the
  // host's checkout status answer is held, then lets the answer through.
  async function archiveWhileOpeningAnotherWorkspace(
    page: Page,
    slug: string,
    startArchive: (worktree: { workspaceId: string }) => Promise<void>,
  ): Promise<string> {
    const serverId = getServerId();
    const worktree = await createWorktree(slug);
    const statusRequest = await holdCheckoutStatusRequest(page, worktree.workspaceDirectory);
    await openSidebarRow(page, worktree.workspaceId);
    await workspaceRow(page, worktree.workspaceId).click();
    await expectAppRoute(page, buildHostWorkspaceRoute(serverId, worktree.workspaceId));

    statusRequest.arm();
    await startArchive(worktree);
    await statusRequest.waitForHeld();
    await workspaceRow(page, worktree.project.workspaceId).click();
    const openedRoute = buildHostWorkspaceRoute(serverId, worktree.project.workspaceId);
    await expectAppRoute(page, openedRoute);

    statusRequest.release();
    await expect(undoButton(page)).toBeVisible();
    // The redirect runs before the archive request, so once the host has archived the worktree
    // any redirect has already happened.
    await expect
      .poll(() => hostListsWorkspace(worktree.workspaceId), { timeout: 30_000 })
      .toBe(false);
    return openedRoute;
  }

  test("opening another workspace while the host answers keeps it open after a row archive", async ({
    page,
  }) => {
    const openedRoute = await archiveWhileOpeningAnotherWorkspace(
      page,
      "archive-risk-switch-row",
      (worktree) => clickRowArchiveButton(page, worktree.workspaceId),
    );
    await expectAppRoute(page, openedRoute);
  });

  test("opening another workspace while the host answers keeps it open after a git actions archive", async ({
    page,
  }) => {
    const openedRoute = await archiveWhileOpeningAnotherWorkspace(
      page,
      "archive-risk-switch-git",
      () => gitActionsArchiveButton(page).click(),
    );
    await expectAppRoute(page, openedRoute);
  });

  test("archiving the open worktree from its git actions leaves it for a new workspace", async ({
    page,
  }) => {
    const worktree = await createWorktree("archive-risk-git-redirect");
    await openSidebarRow(page, worktree.workspaceId);
    await workspaceRow(page, worktree.workspaceId).click();
    await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), worktree.workspaceId));

    await gitActionsArchiveButton(page).click();

    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
  });
});
