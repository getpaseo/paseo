import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test as base, type Page } from "../fixtures";
import appPackage from "../../../package.json";
import { gotoAppShell, openSettings } from "./app";
import { addConnectedHostAndReload } from "./hosts";
import { pluginRequirements } from "./plugin-fixture";
import {
  expectToast,
  openPluginPage,
  pluginPageName,
  selectInstalledTab,
  selectPluginPageAction,
} from "./plugin-gallery";
import { openHostSection, selectSettingsHost } from "./settings";
import { startHostDaemon } from "./versioned-host-daemon";

/**
 * Settings → Plugins → Browse against a host whose registry is a local server. The one listing
 * installs from a local Git repository, so installing needs no network.
 */

export const LISTING = {
  id: "acme/directory-example",
  name: "Directory example",
  description: "Adds a review checklist to every workspace",
  overview: "Directory example keeps a checklist beside your agents.",
};

export const test = base.extend<{ directoryHost: { serverId: string; port: number } }>({
  directoryHost: async ({ e2eWorker }, provide) => {
    void e2eWorker;
    const root = await mkdtemp(path.join(tmpdir(), "paseo-plugin-directory-"));
    const registry = await startRegistry(await createListedPlugin(root));
    try {
      const host = await startHostDaemon({
        version: appPackage.version,
        pluginRegistryUrl: registry.url,
      });
      try {
        await provide({ serverId: host.serverId, port: host.port });
      } finally {
        await host.dispose();
      }
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  },
});

async function createListedPlugin(root: string) {
  const repository = path.join(root, "repository");
  execFileSync("git", ["init", "-b", "main", repository], { stdio: "ignore" });
  await writeFile(
    path.join(repository, "paseo-plugin.json"),
    JSON.stringify({
      id: "directory-example",
      name: LISTING.name,
      requirements: pluginRequirements,
    }),
  );
  await writeFile(
    path.join(repository, "index.client.ts"),
    "export default function () { return () => {}; }",
  );
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Paseo Tests", "-c", "user.email=e2e@paseo.test", ...args],
      {
        cwd: repository,
        encoding: "utf8",
      },
    ).trim();
  git("add", "-A");
  git("commit", "-m", "initial");
  const date = "2026-10-03T00:00:00.000Z";
  return {
    id: LISTING.id,
    name: LISTING.name,
    description: LISTING.description,
    categories: ["tools"],
    author: { github: "acme", name: "Acme" },
    repository: { url: "https://github.com/acme/directory-example" },
    artifact: {
      kind: "git",
      remote: pathToFileURL(repository).href,
      commit: git("rev-parse", "HEAD"),
    },
    media: [],
    submittedAt: date,
    reviewedAt: date,
    updatedAt: date,
    publishedAt: date,
    installs: 1200,
  };
}

async function startRegistry(listing: Record<string, unknown>) {
  const documents: Record<string, unknown> = {
    "/index.json": {
      schemaVersion: 1,
      registry: { name: "Local", url: "http://127.0.0.1" },
      categories: [{ slug: "tools", label: "Tools" }],
      plugins: [listing],
      featured: [],
      generatedAt: "2026-10-03T00:00:00.000Z",
    },
    [`/plugins/${LISTING.id}.json`]: {
      ...listing,
      readme: `# ${LISTING.name}\n\n${LISTING.overview}`,
    },
  };
  const server = createServer((request, response) => {
    const document = request.url ? documents[request.url] : undefined;
    if (!document) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(document));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing registry address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function listingRow(page: Page) {
  return page.getByTestId(`plugin-listing-${LISTING.id}`).filter({ visible: true });
}

function browseTab(page: Page) {
  return page.getByRole("button", { name: "Browse", exact: true });
}

/** A host with no plugins opens Plugins on Browse. */
export async function openDirectory(page: Page, host: { serverId: string; port: number }) {
  await gotoAppShell(page);
  await addConnectedHostAndReload(page, { ...host, label: "Plugin directory" });
  await openSettings(page);
  await selectSettingsHost(page, host.serverId);
  await openHostSection(page, host.serverId, "plugins");
  await expect(browseTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(listingRow(page)).toContainText(LISTING.description);
}

/** Install asks first, naming the author and version, then the row offers Uninstall. */
export async function installListingFromRow(page: Page) {
  await listingRow(page).getByTestId(`plugin-install-${LISTING.id}`).click();
  const sheet = page.getByTestId("plugin-install-sheet");
  await expect(sheet).toContainText("Acme");
  await sheet.getByTestId("plugin-install-confirm").click();
  await expect(listingRow(page).getByTestId(`plugin-uninstall-${LISTING.id}`)).toBeVisible({
    timeout: 60_000,
  });
}

/** Installing the first plugin keeps the user on Browse. */
export async function expectStillBrowsing(page: Page) {
  await expect(browseTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /^Installed · 1/ })).toBeVisible();
}

export async function openListingPage(page: Page) {
  await listingRow(page).getByText(LISTING.name, { exact: true }).click();
  await expect(pluginPageName(page)).toHaveText(LISTING.name);
  await expect(page.getByText(LISTING.overview, { exact: true })).toBeVisible();
}

/**
 * Uninstalling keeps the plugin's page open on its listing, back on Install, whether the page was
 * opened from Browse or from the Installed tab.
 */
export async function uninstallFromPage(page: Page) {
  page.once("dialog", (dialog) => dialog.accept());
  await selectPluginPageAction(page, LISTING.name, "Uninstall");
  await expectToast(page, `Uninstalled ${LISTING.name}`);
  await expect(pluginPageName(page)).toHaveText(LISTING.name);
  await expect(
    page.getByTestId(`plugin-install-${LISTING.id}`).filter({ visible: true }),
  ).toBeVisible();
}

export async function installFromPage(page: Page) {
  await page.getByTestId(`plugin-install-${LISTING.id}`).filter({ visible: true }).click();
  await page.getByTestId("plugin-install-confirm").click();
  await expect(
    page.getByRole("button", { name: `Actions for ${LISTING.name}`, exact: true }),
  ).toBeVisible({ timeout: 60_000 });
}

export async function openFromInstalledTab(page: Page) {
  await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
  await selectInstalledTab(page);
  await openPluginPage(page, LISTING.name, "directory-example");
}
