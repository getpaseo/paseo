import { mkdirSync } from "node:fs";
import { expect, type Locator, type Page } from "@playwright/test";
import { createMockIdleAgent } from "./archive-tab";
import { seedWorkspace } from "./seed-client";

export async function seedSearchableCommandCenter() {
  const seed = await seedWorkspace({
    repoPrefix: "command-center-performance-",
    title: "Search workspace",
    git: false,
  });
  try {
    const agents = [];
    for (let index = 0; index < 60; index += 1) {
      agents.push(
        await createMockIdleAgent(seed.client, {
          cwd: seed.repoPath,
          workspaceId: seed.workspaceId,
          title: `Search agent ${String(index).padStart(3, "0")}`,
        }),
      );
    }
    const workspaces = [];
    for (let index = 0; index < 40; index += 1) {
      const path = `${seed.repoPath}/workspace-${index}`;
      mkdirSync(path);
      const result = await seed.client.createWorkspace({
        source: { kind: "directory", path, projectId: seed.projectId },
        title: `Search workspace ${String(index).padStart(3, "0")}`,
      });
      if (!result.workspace) throw new Error(result.error ?? "Workspace creation failed");
      workspaces.push(result.workspace);
    }
    return { ...seed, agents, workspaces };
  } catch (error) {
    await seed.cleanup();
    throw error;
  }
}

export async function observeCommandCenterRowRenders(page: Page) {
  await page.addInitScript(() => {
    globalThis.__PASEO_RENDER_PROFILE_ENABLED__ = true;
  });
}

export async function searchCommandCenter(panel: Locator, query: string) {
  await panel.getByTestId("command-center-input").fill(query);
}

export async function warmCommandCenterRows(page: Page) {
  // FlatList fills its overscan window in timed batches after the first visible frame.
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    globalThis.__PASEO_RENDER_PROFILE_REASONS__ = {};
  });
}

export async function expectOnlyCommandCenterRowRendered(page: Page, resultId: string) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const renders = await page.evaluate(() =>
    Object.fromEntries(
      Object.entries(globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {}).filter(([id]) =>
        id.startsWith("CommandCenterResultRow:"),
      ),
    ),
  );
  expect(renders).toEqual({ [`CommandCenterResultRow:${resultId}`]: { render: 1 } });
}

export async function expectCommandCenterAgentWindow(panel: Locator, total: number) {
  const rows = panel.locator(
    '[data-testid^="command-center-agent-"]:not([data-testid="command-center-agent-subtitle"])',
  );
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(total);
}

export async function scrollToOldestCommandCenterAgent(panel: Locator) {
  await panel.getByTestId("command-center-results").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
}
