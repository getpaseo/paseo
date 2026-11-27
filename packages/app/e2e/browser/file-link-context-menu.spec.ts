import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { commandCenterSection, openCommandCenter } from "../support/helpers/command-center";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const REPLY = [
  "Read [the report](data/report.csv), the [settings](.config/nested/file-55.json),",
  "the [data folder](data) or the [website](https://example.test/docs).",
  "Nothing is at gone.md.",
].join(" ");

async function seedLinkedFiles() {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "file-link-menu-",
    title: "File link actions",
    initialPrompt: "Show the links",
    featureValues: { mockAssistantResponse: REPLY },
  });
  await mkdir(path.join(agent.cwd, "data"), { recursive: true });
  await writeFile(path.join(agent.cwd, "data/report.csv"), "name,total\nalpha,1\n");
  await mkdir(path.join(agent.cwd, ".config/nested"), { recursive: true });
  // Enough siblings that the target row starts outside the tree's viewport.
  await Promise.all(
    Array.from({ length: 60 }, (_, index) =>
      writeFile(
        path.join(agent.cwd, `.config/nested/file-${String(index).padStart(2, "0")}.json`),
        "{}\n",
      ),
    ),
  );
  await agent.client.waitForFinish(agent.agentId, 30_000);
  return agent;
}

function replyLink(page: Page, name: string) {
  return page.getByTestId("assistant-message").getByRole("link", { name, exact: true });
}

function linkMenu(page: Page) {
  return page.getByTestId("markdown-link-menu");
}

function selectedTreeRow(page: Page) {
  return page.locator('[data-testid^="file-explorer-row-"][aria-selected="true"]');
}

async function expectMenuItems(page: Page, names: string[]) {
  await expect(linkMenu(page).getByRole("menuitem")).toHaveText(names);
}

async function dismissMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(linkMenu(page)).toHaveCount(0);
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    animations: "disabled",
  });
}

test("links in chat and file tabs offer file actions and reveal the file in Files", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const agent = await seedLinkedFiles();
  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        "panel-state",
        JSON.stringify({ state: { explorerShowHiddenFiles: false }, version: 0 }),
      );
    });
    await openAgentRoute(page, agent);

    await replyLink(page, "the report").click({ button: "right" });
    await expectMenuItems(page, [
      "Open file",
      "Open to the side",
      "Reveal in Files",
      "Download",
      "Copy path",
      "Copy relative path",
    ]);
    await screenshot(page, "chat-file-link-menu");
    await dismissMenu(page);

    await replyLink(page, "data folder").click({ button: "right" });
    await expectMenuItems(page, ["Reveal in Files", "Copy path", "Copy relative path"]);
    await dismissMenu(page);

    await replyLink(page, "website").click({ button: "right" });
    await expectMenuItems(page, ["Open in default browser", "Copy link"]);
    await screenshot(page, "chat-web-link-menu");
    await dismissMenu(page);

    // A bare name is looked up while the menu is open; acting on one that matches nothing says so.
    await replyLink(page, "gone.md").click({ button: "right" });
    await linkMenu(page).getByRole("menuitem", { name: "Download" }).click();
    await expect(page.getByTestId("assistant-file-link-not-found-toast")).toContainText("gone.md");

    await replyLink(page, "the report").click({ button: "right" });
    await linkMenu(page).getByRole("menuitem", { name: "Reveal in Files" }).click();
    await expect(selectedTreeRow(page)).toContainText("report.csv");
    await expect(replyLink(page, "the report")).toBeVisible();
    await screenshot(page, "reveal-in-files-from-chat-link");

    // A hidden folder, a freshly expanded tree and a row far below the fold.
    await replyLink(page, "settings").click();
    const fileTab = page.getByTestId("workspace-tab-file_.config/nested/file-55.json").first();
    await expect(fileTab).toBeVisible();
    await fileTab.click({ button: "right" });
    const tabMenu = page.getByTestId("workspace-tab-context-file_.config/nested/file-55.json");
    await expect(tabMenu.getByRole("menuitem", { name: "Reveal in Files" })).toBeVisible();
    await expect(tabMenu.getByRole("menuitem", { name: "Copy relative path" })).toBeVisible();
    await screenshot(page, "file-tab-menu");
    await tabMenu.getByRole("menuitem", { name: "Reveal in Files" }).click();
    await expect(selectedTreeRow(page)).toContainText("file-55.json");
    await expect(selectedTreeRow(page)).toBeInViewport();
    await screenshot(page, "reveal-in-files-from-file-tab");

    // The tree is already mounted and scrolled elsewhere. Command Center reveals the active tab.
    await page.getByTestId("file-explorer-tree-scroll").hover();
    await page.mouse.wheel(0, -100_000);
    await expect(selectedTreeRow(page)).not.toBeInViewport();
    const commandCenter = await openCommandCenter(page);
    await commandCenter.getByTestId("command-center-input").fill("Reveal in Files");
    await commandCenterSection(commandCenter, "Reveal in Files").click();
    await expect(selectedTreeRow(page)).toBeInViewport();
  } finally {
    await agent.cleanup();
  }
});
