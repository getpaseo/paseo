import { mkdir, readFile, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { expect, test as base } from "../support/fixtures";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { buildProjectsSettingsRoute } from "@/utils/host-routes";

const test = base.extend<{ searchHost: IsolatedHostDaemon }>({
  searchHost: async ({ page: _page }, provide) => {
    const daemon = await startIsolatedHostDaemon("project-search-settings", {
      mutableRelay: { enabled: false },
    });
    try {
      await provide(daemon);
    } finally {
      await daemon.close();
    }
  },
});

test("failed search directory saves show actionable copy and preserve edits for retry", async ({
  page,
  searchHost,
}) => {
  await seedSavedSettingsHosts(page, [
    {
      serverId: searchHost.serverId,
      label: "Search settings host",
      endpoint: `127.0.0.1:${searchHost.port}`,
    },
  ]);
  await page.goto(buildProjectsSettingsRoute(searchHost.serverId));
  const root = page.getByTestId("project-search-root-0");
  await root.fill("~/projects");

  // A directory at the config file path makes the real daemon's atomic save fail.
  const configPath = path.join(searchHost.paseoHome, "config.json");
  const backupPath = `${configPath}.backup`;
  await rename(configPath, backupPath);
  await mkdir(configPath);
  await page.getByTestId("project-search-save").click();
  await expect(page.getByTestId("project-search-status")).toHaveText(
    "Couldn't save search directories. Your changes are kept. Try again.",
  );
  await expect(root).toHaveValue("~/projects");
  await expect(page.getByTestId("project-search-save")).toBeEnabled();

  await rmdir(configPath);
  await rename(backupPath, configPath);
  await page.getByTestId("project-search-save").click();
  await expect(page.getByTestId("project-search-status")).toHaveText("Saved");
  await expect(page.getByTestId("project-search-save")).toBeDisabled();
  const config = JSON.parse(await readFile(configPath, "utf8"));
  expect(config.projects.searchRoots).toEqual(["~/projects"]);
});
