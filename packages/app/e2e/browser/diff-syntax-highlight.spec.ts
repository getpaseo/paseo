import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import {
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const APP_SETTINGS_KEY = "@paseo:app-settings";

const DIFF_FIXTURE = [
  "Here is a diff block:",
  "",
  "```diff",
  "diff --git a/src/greet.ts b/src/greet.ts",
  "--- a/src/greet.ts",
  "+++ b/src/greet.ts",
  "@@ -1,3 +1,4 @@ export function greet(name: string) {",
  "   const prefix = 'Hello';",
  "-  return `${prefix}, ${name}`;",
  "+  const trimmed = name.trim();",
  "+  return `${prefix}, ${trimmed}!`;",
  "```",
  "",
  "And a patch block:",
  "",
  "```patch",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,2 +1,2 @@",
  " # Paseo",
  "-Old description",
  "+New description",
  "```",
  "",
  "Plus Ruby, Kotlin, TOML, and SQL:",
  "",
  "```ruby",
  "class Greeter",
  '  def hi(name) = "Hello #{name}"',
  "end",
  "```",
  "",
  "```kotlin",
  'val message: String = "Kotlin ready"',
  "```",
  "",
  "```toml",
  "[server]",
  'host = "localhost"',
  "```",
  "",
  "```sql",
  "SELECT id, name FROM users WHERE active = TRUE;",
  "```",
].join("\n");

const FILE_DIFF_CONTENT = [
  "diff --git a/app.py b/app.py",
  "index 1111111..2222222 100644",
  "--- a/app.py",
  "+++ b/app.py",
  "@@ -1,3 +1,3 @@ def greet():",
  " print('hello')",
  "-old_value = 1",
  "+new_value = 2",
].join("\n");

async function saveScreenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
}

function assistantMessages(page: Page) {
  return page.locator("[data-message-id]").filter({ has: page.getByTestId("assistant-message") });
}

test.describe("diff and patch syntax highlighting", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`highlights diff and patch fences in chat (${theme} theme)`, async ({ page }) => {
      await page.addInitScript(
        ({ key, mode }) => {
          localStorage.setItem(key, JSON.stringify({ theme: mode }));
        },
        { key: APP_SETTINGS_KEY, mode: theme },
      );

      const agent = await seedMockAgentWorkspace({
        repoPrefix: `diff-chat-${theme}-`,
        title: `Diff highlight (${theme})`,
        initialPrompt: "Show me the diff and patch.",
        featureValues: { mockAssistantResponse: DIFF_FIXTURE },
      });

      try {
        await agent.client.waitForAgentUpsert(
          agent.agentId,
          (snapshot) => snapshot.status === "idle",
          30_000,
        );
        await openAgentRoute(page, agent);

        const message = assistantMessages(page);
        const expectedColors =
          theme === "dark"
            ? {
                addition: "rgb(152, 195, 121)",
                deletion: "rgb(224, 108, 117)",
                meta: "rgb(92, 99, 112)",
              }
            : {
                addition: "rgb(52, 130, 51)",
                deletion: "rgb(214, 59, 47)",
                meta: "rgb(160, 161, 167)",
              };

        const diffAdd = message.getByText("+  const trimmed = name.trim();", { exact: true });
        const diffDel = message.getByText("-  return `${prefix}, ${name}`;", { exact: true });
        const diffMeta = message.getByText(
          "@@ -1,3 +1,4 @@ export function greet(name: string) {",
          {
            exact: true,
          },
        );
        const patchAdd = message.getByText("+New description", { exact: true });
        const patchDel = message.getByText("-Old description", { exact: true });

        await expect(diffAdd).toBeVisible({ timeout: 30_000 });
        await expect(diffAdd).toHaveCSS("color", expectedColors.addition);
        await expect(diffDel).toHaveCSS("color", expectedColors.deletion);
        await expect(diffMeta).toHaveCSS("color", expectedColors.meta);
        await expect(patchAdd).toHaveCSS("color", expectedColors.addition);
        await expect(patchDel).toHaveCSS("color", expectedColors.deletion);

        const rubyDef = message.getByText("def", { exact: true });
        const kotlinVal = message.getByText("val", { exact: true });
        const tomlHost = message.getByText("host", { exact: true });
        const sqlSelect = message.getByText("SELECT", { exact: true });
        const expectedKeyword = theme === "dark" ? "rgb(198, 120, 221)" : "rgb(166, 38, 164)";
        const expectedProperty = theme === "dark" ? "rgb(209, 154, 102)" : "rgb(152, 104, 1)";
        await expect(rubyDef).toHaveCSS("color", expectedKeyword);
        await expect(kotlinVal).toHaveCSS("color", expectedKeyword);
        await expect(tomlHost).toHaveCSS("color", expectedProperty);
        await expect(sqlSelect).toHaveCSS("color", expectedKeyword);

        await saveScreenshot(page, `chat-diff-patch-${theme}.png`);
      } finally {
        await agent.cleanup();
      }
    });
  }

  test("highlights a .diff file in the Files viewer", async ({ page, withWorkspace }) => {
    await page.addInitScript(
      ({ key }) => {
        localStorage.setItem(key, JSON.stringify({ theme: "dark" }));
      },
      { key: APP_SETTINGS_KEY },
    );
    const workspace = await withWorkspace({ prefix: "diff-file-viewer-" });
    await writeFile(path.join(workspace.repoPath, "changes.diff"), FILE_DIFF_CONTENT);

    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, "changes.diff");
    await expectFileTabOpen(page, "changes.diff");

    const editor = page.getByTestId("file-source-editor").filter({ visible: true });
    await expect(editor).toBeVisible({ timeout: 30_000 });

    const addLine = editor
      .locator(".cm-line", { hasText: "+new_value = 2" })
      .locator("span")
      .first();
    const delLine = editor
      .locator(".cm-line", { hasText: "-old_value = 1" })
      .locator("span")
      .first();
    const metaLine = editor
      .locator(".cm-line", { hasText: "@@ -1,3 +1,3 @@ def greet():" })
      .locator("span")
      .first();

    await expect(addLine).toHaveCSS("color", "rgb(152, 195, 121)");
    await expect(delLine).toHaveCSS("color", "rgb(224, 108, 117)");
    await expect(metaLine).toHaveCSS("color", "rgb(92, 99, 112)");

    await saveScreenshot(page, "files-viewer-diff-dark.png");
  });

  test("highlights a .patch file in the Files viewer (light theme)", async ({
    page,
    withWorkspace,
  }) => {
    await page.addInitScript(
      ({ key }) => {
        localStorage.setItem(key, JSON.stringify({ theme: "light" }));
      },
      { key: APP_SETTINGS_KEY },
    );
    const workspace = await withWorkspace({ prefix: "patch-file-viewer-" });
    await writeFile(path.join(workspace.repoPath, "fix.patch"), FILE_DIFF_CONTENT);

    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, "fix.patch");
    await expectFileTabOpen(page, "fix.patch");

    const editor = page.getByTestId("file-source-editor").filter({ visible: true });
    await expect(editor).toBeVisible({ timeout: 30_000 });

    const addLine = editor
      .locator(".cm-line", { hasText: "+new_value = 2" })
      .locator("span")
      .first();
    const delLine = editor
      .locator(".cm-line", { hasText: "-old_value = 1" })
      .locator("span")
      .first();
    const metaLine = editor
      .locator(".cm-line", { hasText: "@@ -1,3 +1,3 @@ def greet():" })
      .locator("span")
      .first();

    await expect(addLine).toHaveCSS("color", "rgb(52, 130, 51)");
    await expect(delLine).toHaveCSS("color", "rgb(214, 59, 47)");
    await expect(metaLine).toHaveCSS("color", "rgb(160, 161, 167)");

    await saveScreenshot(page, "files-viewer-patch-light.png");
  });
});
