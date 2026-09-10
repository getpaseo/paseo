import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createLocalGithubPrFixture } from "../support/helpers/github-fixtures";
import {
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
  expectStartingRefPickerTriggerPr,
} from "../support/helpers/new-workspace";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test("project PR shortcut opens a fullscreen list and hands the selected PR to workspace setup", async ({
  page,
}, testInfo) => {
  const fixture = await createLocalGithubPrFixture();
  const checkRun = (name: string, conclusion: string) => ({
    __typename: "CheckRun",
    name,
    status: "COMPLETED",
    conclusion,
    detailsUrl: `https://github.com/paseo-e2e/local-fixture/actions/runs/${name}`,
  });
  await writeFile(
    path.join(fixture.mainCheckout.path, ".paseo-e2e-pull-requests.json"),
    JSON.stringify(
      Array.from({ length: 40 }, (_, index) => ({
        number: index + 1,
        title: index === 0 ? fixture.pr.title : `Pull request ${index + 1}`,
        url: fixture.pr.url,
        state: "OPEN",
        body: null,
        labels: [],
        baseRefName: "main",
        headRefName: fixture.pr.branch,
        updatedAt: "2026-01-01T00:00:00Z",
        additions: index === 0 ? 123 : 0,
        deletions: index === 0 ? 4 : 7,
        statusCheckRollup:
          index === 0
            ? [checkRun("build", "SUCCESS"), checkRun("test", "SUCCESS")]
            : [checkRun("lint", "FAILURE"), checkRun("integration", "FAILURE")],
      })),
    ),
  );
  const client = await connectNewWorkspaceDaemonClient();
  const project = await openProjectViaDaemon(client, fixture.mainCheckout.path);
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const shortcut = page.getByTestId(`sidebar-project-pull-requests-${project.projectId}`);
    await page
      .getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(project.projectKey)}`)
      .hover();
    await shortcut.click();
    await expect(page.getByTestId("project-pr-1")).toContainText(fixture.pr.title);
    await expect(page.getByTestId("project-pr-diff-1")).toHaveText("+123-4");
    await expect(page.getByTestId("project-pr-diff-2")).toHaveText("-7");
    await expect(page.getByTestId("project-pr-open")).toBeVisible();
    await expect(page.getByTestId("project-pr-closed")).toBeVisible();
    await expect(
      page.getByTestId("project-pr-checks-1").getByTestId("project-pr-check-passed"),
    ).toHaveCount(1);
    const failed = page.getByTestId("project-pr-checks-2");
    await expect(failed.getByTestId("project-pr-check-failure")).toHaveCount(2);
    await failed.getByRole("button", { name: "lint", exact: true }).hover();
    await expect(page.getByTestId("project-pr-check-tooltip")).toContainText("lint");
    await page
      .context()
      .route("https://github.com/**", (route) => route.fulfill({ body: "CI details" }));
    const popupPromise = page.waitForEvent("popup");
    await failed.getByRole("button", { name: "lint", exact: true }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://github.com/paseo-e2e/local-fixture/actions/runs/lint");
    await popup.close();
    await expect(page.getByTestId("project-pr-close")).toBeVisible();
    const list = page.getByTestId("project-pr-scroll");
    await list.hover();
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByTestId("project-pr-40")).toBeInViewport();
    await expect(page.getByTestId("project-pr-search")).toBeInViewport();
    await page.mouse.wheel(0, -10000);
    await expect(page.getByTestId("project-pr-1")).toBeInViewport();
    await page.mouse.move(600, 20);
    await page.screenshot({ path: testInfo.outputPath("pull-requests-desktop.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-pr-close")).toBeHidden();
    await page
      .getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(project.projectKey)}`)
      .hover();
    await shortcut.click();
    await page.getByTestId("project-pr-1").click();
    await expectStartingRefPickerTriggerPr(page, {
      number: fixture.pr.number,
      title: fixture.pr.title,
      headRef: fixture.pr.branch,
    });
    await expect(page.getByTestId("project-pr-close")).toBeHidden();
    await expect(page.getByTestId("workspace-create-isolation-trigger")).toContainText(
      "New worktree",
    );
  } finally {
    await client.removeProject(project.projectId);
    await client.close();
    await fixture.cleanup();
  }
});
