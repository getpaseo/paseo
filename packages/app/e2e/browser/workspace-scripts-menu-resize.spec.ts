import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import type { PaseoServiceLink } from "@getpaseo/protocol/paseo-config-schema";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  fetchWorkspaceById,
  seedProjectForWorkspaceSetup,
  waitForWorkspaceSetupProgress,
} from "../support/helpers/workspace-setup";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

test("scripts menu resizes and updates configured quick links for a running service", async ({
  page,
}) => {
  const duplicateKeyErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("same key")) {
      duplicateKeyErrors.push(message.text());
    }
  });

  const client = await connectWorkspaceSetupClient();
  const paseoConfig = {
    worktree: {
      setup: ["node -e \"console.log('setup complete')\""],
    },
    scripts: {
      web: {
        type: "service",
        command:
          "node -e \"const http = require('http'); const s = http.createServer((q,r) => r.end(q.url)); s.listen(process.env.PASEO_PORT, () => console.log('listening on ' + s.address().port))\"",
      },
    },
  };
  const repo = await createTempGitRepo("script-menu-resize-", { paseoConfig });

  try {
    await seedProjectForWorkspaceSetup(client, repo.path);
    const completed = waitForWorkspaceSetupProgress(
      client,
      (payload) => payload.status === "completed" && payload.detail.log.includes("setup complete"),
    );
    const workspace = await createWorkspaceThroughDaemon(client, {
      cwd: repo.path,
      worktreeSlug: `script-menu-resize-${Date.now()}`,
    });
    await completed;
    const { workspaceDirectory } = await fetchWorkspaceById(client, workspace.id);

    async function reloadWithLinks(links: PaseoServiceLink[]): Promise<void> {
      const config = {
        ...paseoConfig,
        scripts: { web: { ...paseoConfig.scripts.web, links } },
      };
      await writeFile(path.join(workspaceDirectory, "paseo.json"), JSON.stringify(config));
      await page.reload();
      await waitForWorkspaceTabsVisible(page);
      await page.getByRole("button", { name: "Workspace scripts", exact: true }).click();
    }

    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
    await waitForWorkspaceTabsVisible(page);
    const scriptsTrigger = page.getByRole("button", { name: "Workspace scripts", exact: true });
    await scriptsTrigger.click();

    const menu = page.getByTestId("workspace-scripts-menu");
    await expect(menu).toBeVisible();
    const before = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        height: rect.height,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      };
    });

    await menu.getByRole("button", { name: "Run web script", exact: true }).click();
    await expect(menu).toContainText("localhost:", { timeout: 15_000 });
    const rootAction = menu.getByRole("button", { name: "View web service", exact: true });
    const quickLinks = menu.getByRole("menuitem");
    await expect(rootAction).toBeVisible();
    await expect(quickLinks).toHaveCount(0);

    const afterLaunch = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const childRect = element.firstElementChild?.getBoundingClientRect();
      return {
        height: rect.height,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        childHeight: childRect?.height ?? 0,
      };
    });
    expect(afterLaunch.height).toBeGreaterThan(before.height);
    expect(afterLaunch.scrollHeight).toBeLessThanOrEqual(afterLaunch.clientHeight + 1);
    expect(afterLaunch.childHeight).toBeGreaterThan(before.height);

    const website = { label: "Website", path: "/" };
    const admin = { label: "Admin", path: "/admin" };
    const graphQL = { label: "GraphQL", path: "/api/graphql" };
    await reloadWithLinks([website, admin, graphQL, admin]);
    await expect(quickLinks).toHaveText([
      "Website /",
      "Admin /admin",
      "GraphQL /api/graphql",
      "Admin /admin",
    ]);
    await expect(rootAction).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Website /", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Admin /admin", exact: true })).toHaveCount(2);
    await expect(
      menu.getByRole("menuitem", { name: "GraphQL /api/graphql", exact: true }),
    ).toBeVisible();

    const after = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const firstChild = element.firstElementChild;
      const childRect = firstChild?.getBoundingClientRect();
      return {
        height: rect.height,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        childHeight: childRect?.height ?? 0,
      };
    });

    expect(after.height).toBeGreaterThan(afterLaunch.height);
    expect(after.scrollHeight).toBeLessThanOrEqual(after.clientHeight + 1);
    expect(after.childHeight).toBeGreaterThan(before.height);

    await reloadWithLinks([graphQL, admin, website, admin]);
    await expect(quickLinks).toHaveText([
      "GraphQL /api/graphql",
      "Admin /admin",
      "Website /",
      "Admin /admin",
    ]);
    await reloadWithLinks([admin, graphQL]);
    await expect(quickLinks).toHaveText(["Admin /admin", "GraphQL /api/graphql"]);
    expect(duplicateKeyErrors).toEqual([]);

    const routeSelector = menu.getByRole("button", { name: "Choose URL for web", exact: true });
    const selectedHost = (await routeSelector.innerText()).trim();
    const popupPromise = page.waitForEvent("popup");
    await menu.getByRole("menuitem", { name: "Admin /admin", exact: true }).click();
    const popup = await popupPromise;

    await expect(menu).toBeHidden();
    await expect.poll(() => popup.url()).toBe(`http://${selectedHost}/admin`);
    await expect(popup.locator("body")).toHaveText("/admin");
    await popup.close();

    await reloadWithLinks([{ label: "Unsafe", path: "/\t//evil.example" }]);
    await expect(quickLinks).toHaveCount(0);
    await expect(rootAction).toBeVisible();
    const rootPopupPromise = page.waitForEvent("popup");
    await rootAction.click();
    const rootPopup = await rootPopupPromise;
    await expect.poll(() => rootPopup.url()).toBe("http://" + selectedHost + "/");
    await expect(rootPopup.locator("body")).toHaveText("/");
    await rootPopup.close();
  } finally {
    await client.close();
    await repo.cleanup();
  }
});
