import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { connectSeedClient } from "./seed-client";
import { createTempDirectory } from "./workspace";
import { waitForSidebarHydration } from "./workspace-ui";

const SECONDARY_LABEL = "devbox.example.com";

type Client = Awaited<ReturnType<typeof connectSeedClient>>;

class ProjectSecondaryLabelHarness {
  private constructor(
    private readonly page: Page,
    private readonly directory: Awaited<ReturnType<typeof createTempDirectory>>,
    private readonly client: Client,
    private readonly projectId: string,
  ) {}

  static async create(page: Page): Promise<ProjectSecondaryLabelHarness> {
    const directory = await createTempDirectory("project-secondary-label-");
    const client = await connectSeedClient();
    let projectId: string | null = null;
    try {
      const opened = await client.openProject(directory.path, {
        projectPresentation: { secondaryLabel: SECONDARY_LABEL },
      });
      expect(opened.error).toBeNull();
      expect(opened.workspace).not.toBeNull();
      projectId = opened.workspace!.projectId;
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      return new ProjectSecondaryLabelHarness(page, directory, client, projectId);
    } catch (error) {
      if (projectId) await client.removeProject(projectId).catch(() => undefined);
      await client.close().catch(() => undefined);
      await directory.cleanup().catch(() => undefined);
      throw error;
    }
  }

  async expectRightAlignedPresentation(): Promise<void> {
    const primaryLabel = path.basename(this.directory.path);
    const row = this.page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: primaryLabel })
      .first();
    const primary = row.locator('[data-testid^="sidebar-project-primary-label-"]');
    const secondary = row.locator('[data-testid^="sidebar-project-secondary-label-"]');

    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(primary).toHaveText(primaryLabel);
    await expect(secondary).toHaveText(SECONDARY_LABEL);

    const [rowBounds, primaryBounds, secondaryBounds] = await Promise.all([
      row.boundingBox(),
      primary.boundingBox(),
      secondary.boundingBox(),
    ]);
    expect(rowBounds).not.toBeNull();
    expect(primaryBounds).not.toBeNull();
    expect(secondaryBounds).not.toBeNull();
    expect(secondaryBounds!.x).toBeGreaterThan(primaryBounds!.x);
    expect(secondaryBounds!.x + secondaryBounds!.width).toBeLessThanOrEqual(
      rowBounds!.x + rowBounds!.width,
    );
  }

  async dispose(): Promise<void> {
    await this.client.removeProject(this.projectId).catch(() => undefined);
    await this.client.close().catch(() => undefined);
    await this.directory.cleanup().catch(() => undefined);
  }
}

export async function withProjectSecondaryLabel(
  page: Page,
  run: (project: ProjectSecondaryLabelHarness) => Promise<void>,
): Promise<void> {
  const project = await ProjectSecondaryLabelHarness.create(page);
  try {
    await run(project);
  } finally {
    await project.dispose();
  }
}
