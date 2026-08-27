import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { installDesktopRuntime } from "./support/runtime";
import { clickSettingsBackToWorkspace } from "../../app/e2e/support/helpers/settings";
import { openAgentRoute, seedMockAgentWorkspace } from "../../app/e2e/support/helpers/mock-agent";

interface EditorOpenRecord {
  editorId: string;
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
}

function requireE2EEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

async function readEditorOpenRecords(recordPath: string): Promise<EditorOpenRecord[]> {
  try {
    const contents = await readFile(recordPath, "utf8");
    return contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EditorOpenRecord);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function chooseEditorTarget(page: Page, targetId: "vscode"): Promise<void> {
  await expect(page.getByTestId("workspace-open-in-editor-primary")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("workspace-open-in-editor-caret").click();
  await expect(page.getByTestId("workspace-open-in-editor-menu")).toBeVisible();
  await page.getByTestId(`workspace-open-in-editor-item-${targetId}`).click();
}

async function expectEditorOpened(input: {
  recordPath: string;
  editorId: string;
  path: string;
  afterCount: number;
}): Promise<void> {
  await expect
    .poll(
      async () => {
        const records = await readEditorOpenRecords(input.recordPath);
        return records
          .slice(input.afterCount)
          .some(
            (record) => record.editorId === input.editorId && record.workspacePath === input.path,
          );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

test.describe("Workspace open in editor", () => {
  test("opens a Ctrl-clicked assistant file link in the selected target", async ({ page }) => {
    test.setTimeout(90_000);

    const serverId = requireE2EEnv("E2E_SERVER_ID");
    const recordPath = requireE2EEnv("E2E_EDITOR_RECORD_PATH");
    await rm(recordPath, { force: true });
    await installDesktopRuntime(page, {
      serverId,
      editorTargets: [
        {
          id: "cursor",
          label: "Cursor",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
        {
          id: "vscode",
          label: "VS Code",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
      ],
      editorRecordPath: recordPath,
    });
    const target = "target.ts:42";
    const session = await seedMockAgentWorkspace({
      repoPrefix: "desktop-assistant-file-link-",
      title: "Desktop assistant file link",
      initialPrompt: [
        "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
        "Return JSON only with fields 'title' and 'branch'.",
        "",
        "<user-prompt>",
        `Open \`${target}\` now`,
        "</user-prompt>",
      ].join("\n"),
    });
    await writeFile(path.join(session.cwd, "target.ts"), "export const target = true;\n", "utf8");

    try {
      await openAgentRoute(page, session);
      await chooseEditorTarget(page, "vscode");
      const recordCount = (await readEditorOpenRecords(recordPath)).length;
      const fileLink = page.getByText(target, { exact: true });
      await expect(fileLink).toBeVisible({ timeout: 15_000 });

      await fileLink.click({ modifiers: ["Control"] });

      await expect
        .poll(async () => (await readEditorOpenRecords(recordPath)).slice(recordCount))
        .toContainEqual({
          editorId: "vscode",
          workspacePath: session.cwd,
          filePath: path.join(session.cwd, "target.ts"),
          line: 42,
        });
    } finally {
      await session.cleanup();
    }
  });

  test("keeps the selected editor target after leaving and returning to the workspace", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);

    const serverId = requireE2EEnv("E2E_SERVER_ID");
    const recordPath = requireE2EEnv("E2E_EDITOR_RECORD_PATH");
    await rm(recordPath, { force: true });
    await installDesktopRuntime(page, {
      serverId,
      editorTargets: [
        {
          id: "cursor",
          label: "Cursor",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
        {
          id: "vscode",
          label: "VS Code",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
      ],
      editorRecordPath: recordPath,
    });

    const workspace = await withWorkspace({ prefix: "workspace-editor-target-" });
    await workspace.navigateTo();

    await chooseEditorTarget(page, "vscode");
    await expectEditorOpened({
      recordPath,
      editorId: "vscode",
      path: workspace.repoPath,
      afterCount: 0,
    });
    const recordsAfterSelection = (await readEditorOpenRecords(recordPath)).length;

    await openSettings(page);
    await clickSettingsBackToWorkspace(page);
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });

    await page.getByTestId("workspace-open-in-editor-primary").click();
    await expectEditorOpened({
      recordPath,
      editorId: "vscode",
      path: workspace.repoPath,
      afterCount: recordsAfterSelection,
    });
    const recordsAfterReturnOpen = (await readEditorOpenRecords(recordPath)).length;

    await gotoAppShell(page);
    await workspace.navigateTo();
    await page.getByTestId("workspace-open-in-editor-primary").click();
    await expectEditorOpened({
      recordPath,
      editorId: "vscode",
      path: workspace.repoPath,
      afterCount: recordsAfterReturnOpen,
    });
  });
});
