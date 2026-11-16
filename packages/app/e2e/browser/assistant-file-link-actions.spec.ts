import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

const filename = "résumé final.md";
const binary = Buffer.from([0, 1, 128, 255]);
let agent: MockAgentWorkspace;

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-file-actions-",
    title: "File link actions",
    featureValues: {
      mockAssistantResponse:
        "[the report](docs/r%C3%A9sum%C3%A9%20final.md:7) [binary](docs/report.bin) `missing.md` [website](https://example.com)",
    },
  });
  await mkdir(path.join(agent.cwd, "docs"));
  await writeFile(path.join(agent.cwd, "docs", filename), "# Example report\n");
  await writeFile(path.join(agent.cwd, "docs/report.bin"), binary);
  await agent.client.sendAgentMessage(agent.agentId, "Show the files.");
  await agent.client.waitForFinish(agent.agentId, 30_000);
  await openAgentRoute(page, agent);
});

test.afterEach(async () => {
  await agent.cleanup();
});

async function openMenu(page: Page, name = "the report") {
  await page.getByRole("link", { name, exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy path", exact: true })).toBeVisible();
}

async function expectCopiedReport(page: Page) {
  await page.getByRole("menuitem", { name: "Copy path", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Copied", exact: true })).toBeVisible();
  const expected = path.join(agent.cwd, "docs", filename).replaceAll("\\", "/");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
}

test("file actions work on history after a reload and copy a decoded path without its line suffix", async ({
  page,
}) => {
  await page.reload();
  await openMenu(page);
  await expectCopiedReport(page);
});

test("keyboard opens the file menu and Escape returns focus to the link", async ({ page }) => {
  const link = page.getByRole("link", { name: "the report", exact: true });
  await link.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Copy path", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
});

test("reveals the containing folder in Paseo and selects the linked file", async ({ page }) => {
  await openMenu(page);
  await page.getByRole("menuitem", { name: "Reveal in Paseo", exact: true }).click();
  const tree = page.getByTestId("file-explorer-tree-scroll");
  await expect(tree.getByText(filename, { exact: true })).toBeVisible();
  await expect(tree.locator('[aria-selected="true"]')).toContainText(filename);
});

test("downloads a linked binary through the existing file download flow", async ({
  page,
}, testInfo) => {
  await openMenu(page, "binary");
  const received = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  const download = await received;
  const destination = testInfo.outputPath("report.bin");
  await download.saveAs(destination);
  expect(await readFile(destination)).toEqual(binary);
});

test("a missing inline path keeps an error visible and can be retried after the file is created", async ({
  page,
}) => {
  await openMenu(page, "missing.md");
  await page.getByRole("menuitem", { name: "Copy path", exact: true }).click();
  await expect(page.getByText("No file found for missing.md", { exact: true })).toBeVisible();
  await writeFile(path.join(agent.cwd, "missing.md"), "Now present\n");
  await page.getByRole("menuitem", { name: /^Copy path/ }).click();
  await expect(page.getByRole("menuitem", { name: "Copied", exact: true })).toBeVisible();
});

test("web URLs do not acquire file actions", async ({ page }) => {
  await page.getByRole("link", { name: "website", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy path", exact: true })).toHaveCount(0);
});

test("compact layouts offer the same file actions in a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMenu(page);
  await expect(page.getByRole("menuitem", { name: "Reveal in Paseo", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Download", exact: true })).toBeVisible();
  await expectCopiedReport(page);
});
