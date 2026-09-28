import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { composerLocator } from "../support/helpers/composer";
import { getServerId } from "../support/helpers/server-id";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";
import { createTempDirectory, type TempDirectory } from "../support/helpers/workspace";
import {
  createAgentTabFromMenu,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

const sessionDir = mkdtempSync(path.join(tmpdir(), "paseo-resume-omp-sessions-"));
const title = "Resumed OMP sidebar fixture";
const prompt = "Keep this CLI session visible in the sidebar";
const sessionId = randomUUID();
const sessionFile = path.join(sessionDir, "fixture", `${sessionId}.jsonl`);
let directory: TempDirectory;
let initialWorkspaceId: string;

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: { providers: { omp: { enabled: true, params: { sessionDir } } } },
  },
  e2eDaemonEnvironment: { OMP_SESSION_DIR: sessionDir },
});
test.setTimeout(90_000);
test.skip(spawnSync("omp", ["--version"], { stdio: "ignore" }).status !== 0, "Requires OMP CLI");

test.beforeAll(async ({ e2eWorkerClient }) => {
  directory = await createTempDirectory("resume-omp-workspace-");
  const created = await e2eWorkerClient.createWorkspace({
    source: { kind: "directory", path: directory.path },
  });
  if (!created.workspace) throw new Error(created.error ?? "Could not create fixture workspace");
  initialWorkspaceId = created.workspace.id;

  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(
    sessionFile,
    `${[
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-09-28T10:00:00.000Z",
        cwd: directory.path,
      },
      {
        type: "title",
        id: `${sessionId}-title`,
        timestamp: "2026-09-28T10:00:01.000Z",
        title,
      },
      {
        type: "message",
        id: `${sessionId}-user`,
        timestamp: "2026-09-28T10:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
});

test.afterAll(async () => {
  await directory?.cleanup();
  await rm(sessionDir, { recursive: true, force: true });
});

test("/resume gives an OMP CLI session a separate sidebar workspace", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), initialWorkspaceId));
  await waitForWorkspaceTabsVisible(page);
  await createAgentTabFromMenu(page);

  const composer = composerLocator(page);
  await composer.fill("/resume");
  await composer.press("Enter");
  const sheet = page.getByTestId("import-session-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("import-session-filter-trigger").click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  const session = sheet.getByTestId(`import-session-session-omp-${sessionFile}`);
  await expect(session).toBeVisible({ timeout: 30_000 });
  await session.click();

  await expect(sheet).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("user-message")).toContainText(prompt, { timeout: 30_000 });
  const sidebarEntry = page
    .locator('[data-testid^="sidebar-workspace-row-"]')
    .filter({ hasText: title });
  await expect(sidebarEntry).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByTestId(`sidebar-workspace-row-${getServerId()}:${initialWorkspaceId}`),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("resume-omp-sidebar.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await openMobileAgentSidebar(page);
  await expectMobileAgentSidebarVisible(page);
  await expect(sidebarEntry).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("resume-omp-mobile-sidebar.png") });
});
