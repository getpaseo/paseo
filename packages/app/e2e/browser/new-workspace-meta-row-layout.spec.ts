import { expect, test } from "../support/fixtures";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  openStartingRefPicker,
  selectBranchInPicker,
  selectWorkspaceRuntime,
} from "../support/helpers/new-workspace";
import {
  gotoNewWorkspaceForRuntime,
  seedGitProjectForRuntime,
  type SeededRuntimeProject,
} from "../support/helpers/new-workspace-runtime";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";

const LONG_HOST_NAME =
  "development-macbook-pro.local-connected-through-a-very-long-private-hostname";
const LONG_BRANCH_NAME =
  "feat/app/add-amoled-theme-with-a-very-long-pull-request-and-branch-description";

function measureControlRightEdges(controls: HTMLElement[]) {
  const measurements: Array<{ label: string | null; right: number }> = [];
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    measurements.push({ label: control.getAttribute("aria-label"), right: rect.right });
  }
  return measurements;
}

test.describe("New workspace metadata row layout", () => {
  let project: SeededRuntimeProject;

  test.beforeEach(async () => {
    project = await seedGitProjectForRuntime({ branches: [LONG_BRANCH_NAME] });
  });

  test.afterEach(async () => {
    await project?.cleanup();
  });

  test("long host and branch names stay inside the composer's right rail", async ({ page }) => {
    await page.setViewportSize({ width: 2048, height: 878 });
    await seedSavedSettingsHosts(page, [
      {
        serverId: getServerId(),
        label: LONG_HOST_NAME,
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      },
      {
        serverId: "srv_e2e_layout_offline",
        label: "Offline host",
        endpoint: "127.0.0.1:9",
      },
    ]);

    await gotoNewWorkspaceForRuntime(page, project);
    await selectWorkspaceRuntime(page, "worktree");
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, LONG_BRANCH_NAME);

    const composer = page.locator('[data-testid="message-input-root"]:visible');
    const metadataRow = page.getByTestId("new-workspace-ref-picker-row");
    await expect(composer).toBeVisible();
    await expect(metadataRow).toBeVisible();

    const [composerBox, controlBoxes] = await Promise.all([
      composer.boundingBox(),
      metadataRow.getByRole("button").evaluateAll(measureControlRightEdges),
    ]);
    expect(composerBox).not.toBeNull();
    const composerRightRail = composerBox!.x + composerBox!.width;

    for (const control of controlBoxes) {
      expect(
        control.right,
        `${control.label ?? "Metadata control"} crossed the composer rail`,
      ).toBeLessThanOrEqual(composerRightRail + 1);
    }
  });
});
