import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import {
  expandFolder,
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { gotoAppShell } from "../support/helpers/app";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const APP_SETTINGS_KEY = "@paseo:app-settings";

const RED_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
const BLUE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const BLOCKED_PREVIEW_URL = "https://html-preview.invalid/leak";

interface LinkedFile {
  target: string;
  fileName: string;
  content: string;
}

function editor(page: Page) {
  return page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-content");
}

function hasHorizontalOverflow(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth;
}

function fitsViewportWidth(element: HTMLElement): boolean {
  return element.scrollWidth === element.clientWidth;
}

async function replaceEditorText(page: Page, content: string): Promise<void> {
  await editor(page).fill(content);
}

async function openWorkspaceFile(page: Page, filename: string): Promise<void> {
  const tree = page.getByTestId("file-explorer-tree-scroll");
  if (!(await tree.isVisible())) await openFileExplorer(page);
  await openFileFromExplorer(page, filename);
  await expectFileTabOpen(page, filename);
}

function htmlPreview(page: Page) {
  return {
    host: page.getByTestId("file-html-preview"),
    document: page.frameLocator('[data-testid="file-html-preview"]'),
  };
}

async function followHtmlPreviewLink(page: Page, name: string): Promise<void> {
  await htmlPreview(page).document.getByRole("link", { name, exact: true }).click();
}

async function expectPageHandlesFragment(
  page: Page,
  handler: "Document" | "Window",
): Promise<void> {
  const preview = htmlPreview(page);
  await followHtmlPreviewLink(page, `${handler} handled jump`);
  await expect(preview.document.getByRole("status")).toHaveText(`${handler} handled click`);
  await expect(
    preview.document.getByRole("heading", { name: "Target section" }),
  ).not.toBeInViewport();
  expect(await preview.document.locator("body").evaluate(() => location.hash)).toBe("");
  expect(await preview.document.locator("body").evaluate(() => window.scrollY)).toBe(0);
}

async function selectFileView(page: Page, view: "Preview" | "Source"): Promise<void> {
  const option = page.getByTestId("file-panel-bar").getByRole("button", {
    name: view,
    exact: true,
  });
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
}

async function expectAbove(upper: Locator, lower: Locator): Promise<void> {
  const [upperBox, lowerBox] = await Promise.all([upper.boundingBox(), lower.boundingBox()]);
  expect(upperBox).not.toBeNull();
  expect(lowerBox).not.toBeNull();
  expect(upperBox!.y + upperBox!.height).toBeLessThanOrEqual(lowerBox!.y);
}

/** How many times the app has read the file's contents from the daemon. */
function fileReadCount(
  gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>,
  fileName: string,
): number {
  return gate
    .getClientRequests("file_explorer_request")
    .filter((request) => request.mode === "file" && String(request.path).endsWith(fileName)).length;
}

async function expectMarkdownImageLoaded(page: Page, name: string): Promise<void> {
  const image = page.getByRole("button", { name, exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
}

function watchRequestsTo(page: Page, origin: string): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(origin)) requests.push(request.url());
  });
  return requests;
}

async function seedAgentWithFileLink(input: LinkedFile) {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "file-editing-chat-link-",
    title: "Chat file link e2e",
    initialPrompt: [
      "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
      "Return JSON only with fields 'title' and 'branch'.",
      "",
      "<user-prompt>",
      `Open \`${input.target}\` now`,
      "</user-prompt>",
    ].join("\n"),
  });
  await writeFile(path.join(session.cwd, input.fileName), input.content, "utf8");
  return session;
}

test.describe("CodeMirror workspace file editing", () => {
  test("opens explicit screenshot links and explains missing files", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "screenshot-markdown-link-",
      title: "Screenshot file links",
      initialPrompt: "Show screenshots",
      featureValues: {
        mockAssistantResponse:
          "[Capture](.dev/tablet-review/capture.png) [Missing capture](.dev/tablet-review/missing.png)",
      },
    });
    try {
      await mkdir(path.join(session.cwd, ".dev/tablet-review"), { recursive: true });
      await writeFile(path.join(session.cwd, ".dev/tablet-review/capture.png"), RED_PIXEL);
      await openAgentRoute(page, session);
      await test.step("Open the linked screenshot", async () => {
        await openAssistantMarkdownLink(page, "Capture");
        await expectFileTabOpen(page, ".dev/tablet-review/capture.png");
        await expect(page.getByTestId("image-file-preview-canvas")).toBeVisible();
      });
      await test.step("Explain why the missing screenshot cannot open", async () => {
        await returnToAssistant(page, session.agentId);
        await openAssistantMarkdownLink(page, "Missing capture");
        await expectFileTabOpen(page, ".dev/tablet-review/missing.png");
        await expect(page.getByText("File not found", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      });
    } finally {
      await session.cleanup();
    }
  });

  test("opens the non-ASCII file named by an assistant markdown link", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "encoded-markdown-link-",
      title: "Non-ASCII file link",
      initialPrompt: "Show the report link",
      featureValues: { mockAssistantResponse: "[报告](docs/reports/开户赠金.md)" },
    });
    try {
      await mkdir(path.join(session.cwd, "docs/reports"), { recursive: true });
      await writeFile(path.join(session.cwd, "docs/reports/开户赠金.md"), "# Report opened\n");
      await openAgentRoute(page, session);
      await openAssistantMarkdownLink(page, "报告");
      await expectFileTabOpen(page, "docs/reports/开户赠金.md");
      await expect(
        page
          .getByTestId("workspace-file-pane")
          .filter({ visible: true })
          .getByText("Report opened", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("non-ascii-file-opened.png") });
    } finally {
      await session.cleanup();
    }
  });

  for (const order of ["raw-first", "href-first"] as const) {
    test(`opens literal and encoded percent filenames independently ${order}`, async ({ page }) => {
      const session = await seedMockAgentWorkspace({
        repoPrefix: "percent-link-cache-",
        title: "Distinct file links",
        initialPrompt: "Show both filenames",
        featureValues: {
          mockAssistantResponse: "Raw `literal%20.md`. [Decoded](literal%20.md).",
        },
      });
      try {
        await writeFile(path.join(session.cwd, "literal%20.md"), "# Literal filename\n");
        await writeFile(path.join(session.cwd, "literal .md"), "# Decoded filename\n");
        await openAgentRoute(page, session);
        const links = order === "raw-first" ? ["raw", "href"] : ["href", "raw"];
        for (const link of links) {
          await returnToAssistant(page, session.agentId);
          if (link === "raw") {
            await openAssistantInlinePath(page, "literal%20.md");
            await expectFileTabOpen(page, "literal%20.md");
            await expectPreviewText(page, "Literal filename");
          } else {
            await openAssistantMarkdownLink(page, "Decoded");
            await expectFileTabOpen(page, "literal .md");
            await expectPreviewText(page, "Decoded filename");
          }
        }
      } finally {
        await session.cleanup();
      }
    });
  }

  test("jumps to each relative reference to the same file", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "relative-reference-qa-",
      title: "Relative line references",
      initialPrompt: "Show both references",
      featureValues: {
        mockAssistantResponse: "First `src/router.go:46`. Then `src/router.go:403`.",
      },
    });
    try {
      await mkdir(path.join(session.cwd, "src"));
      await writeFile(
        path.join(session.cwd, "src/router.go"),
        Array.from({ length: 450 }, (_, n) => `// line ${n + 1}`).join("\n"),
      );
      await openAgentRoute(page, session);
      for (const line of [46, 403, 46]) {
        await page
          .getByTestId(`workspace-tab-agent_${session.agentId}`)
          .filter({ visible: true })
          .click();
        await page.getByText(`src/router.go:${line}`, { exact: true }).click();
        await expect(page.getByLabel(`Line ${line}, column 1`)).toBeVisible();
      }
      await page.screenshot({ path: test.info().outputPath("relative-line-target.png") });
    } finally {
      await session.cleanup();
    }
  });

  test("shows an absolute POSIX assistant file link relative to the workspace on hover", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "file-link-tooltip-" });
    const filePath = path.join(workspace.repoPath, "src", "target.ts");
    try {
      const agent = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Absolute file link tooltip",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "Show the file link",
        featureValues: { mockAssistantResponse: `[Open target](${filePath}:42-45)` },
      });
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      const workspaceRow = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(workspaceRow).toBeVisible({ timeout: 30_000 });
      await workspaceRow.click();
      await page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).click();

      const fileLink = page.getByRole("link", { name: "Open target" }).first();
      await expect(fileLink).toBeVisible({ timeout: 15_000 });
      await fileLink.hover();
      await expect(fileLink).toHaveAttribute("title", "src/target.ts:42-45");
    } finally {
      await workspace.cleanup();
    }
  });

  test("renders a lockfile-sized read-only source with a bounded CodeMirror DOM", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "file-source-lockfile-",
      title: "Large source",
      initialPrompt: "Generate a title and a git branch name. Return JSON only.",
    });
    const lockfile = `${'{"packages":['}${Array.from({ length: 42_000 }, (_, index) => `{"name":"package-${index}","version":"1.0.0"}`).join(",")}]}`;
    await writeFile(path.join(session.cwd, "package-lock.json"), lockfile, "utf8");

    try {
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, "package-lock.json");

      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(editor(page)).toContainText('"package-0"');
      await expect.poll(() => page.locator(".cm-line").count()).toBeLessThan(200);
    } finally {
      await session.cleanup();
    }
  });

  test("keeps the app interactive around a plain 11 MB source", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "file-source-plain-",
      title: "Plain large source",
      initialPrompt: "Generate a title and a git branch name. Return JSON only.",
    });
    await writeFile(
      path.join(session.cwd, "plain.txt"),
      "plain source\n".repeat(1_050_000),
      "utf8",
    );

    try {
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, "plain.txt");
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(editor(page)).toContainText("plain source");
      await expect.poll(() => page.locator(".cm-line").count()).toBeLessThan(200);

      await page.getByTestId(`workspace-tab-agent_${session.agentId}`).first().click();
      await expect(page.getByTestId("message-input-root")).toBeVisible();
      await page.getByTestId("workspace-tab-file_plain.txt").first().click();
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("refuses a file above the display budget and keeps its tab recoverable", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "file-source-unsupported-",
      title: "Unsupported large source",
      initialPrompt: "Generate a title and a git branch name. Return JSON only.",
    });
    await writeFile(path.join(session.cwd, "too-large.txt"), "x".repeat(51 * 1024 * 1024), "utf8");

    try {
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, "too-large.txt");
      await expect(page.getByTestId("file-source-too-large")).toContainText(
        "This file is too large to display",
      );

      await page.getByTestId(`workspace-tab-agent_${session.agentId}`).first().click();
      await expect(page.getByTestId("message-input-root")).toBeVisible();
      await page.getByTestId("workspace-tab-file_too-large.txt").first().click();
      await expect(page.getByTestId("file-source-too-large")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("opens an assistant file link at its referenced line", async ({ page }) => {
    const target = "target.ts:42";
    const session = await seedAgentWithFileLink({
      target,
      fileName: "target.ts",
      content: Array.from(
        { length: 80 },
        (_, index) => `export const line${index + 1} = ${index + 1};`,
      ).join("\n"),
    });

    try {
      await openAgentRoute(page, session);

      const fileLink = page.getByText(target, { exact: true });
      await expect(fileLink).toBeVisible({ timeout: 15_000 });
      await fileLink.click();

      await expectFileTabOpen(page, "target.ts");
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(page.getByLabel("Line 42, column 1")).toBeVisible();
      await expect(
        page.getByTestId("file-source-editor").locator(".cm-line", { hasText: "line42 = 42" }),
      ).toBeVisible();

      const sourceEditor = editor(page);
      await sourceEditor.click();
      await sourceEditor.press("ControlOrMeta+Home");
      await expect(page.getByLabel(/^Line 1, column \d+$/)).toBeVisible();

      await page
        .getByTestId(`workspace-tab-agent_${session.agentId}`)
        .filter({ visible: true })
        .click();
      await expect(fileLink).toBeVisible();
      await fileLink.click();

      await expect(page.getByLabel("Line 42, column 1")).toBeVisible();
      await expect(
        page.getByTestId("file-source-editor").locator(".cm-line", { hasText: "line42 = 42" }),
      ).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("clicking the editor focuses its pane beside an agent", async ({ page }) => {
    await page.addInitScript((settingsKey) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({ openInSidePane: { explorerFiles: true } }),
      );
    }, APP_SETTINGS_KEY);
    const target = "target.ts:42";
    const session = await seedAgentWithFileLink({
      target,
      fileName: "target.ts",
      content: Array.from(
        { length: 80 },
        (_, index) => `export const line${index + 1} = ${index + 1};`,
      ).join("\n"),
    });

    try {
      // Keep both tab rails available alongside the docked Explorer.
      await page.setViewportSize({ width: 1900, height: 900 });
      await openAgentRoute(page, session);

      await openWorkspaceFile(page, "target.ts");
      await expect(
        page
          .locator('[data-testid^="workspace-pane-"]')
          .getByTestId("workspace-tabs-row")
          .filter({ visible: true }),
      ).toHaveCount(2);

      await page
        .getByTestId(`workspace-tab-agent_${session.agentId}`)
        .filter({ visible: true })
        .click();
      await editor(page).click();
      await page.keyboard.press("Alt+Shift+W");

      await expect(page.getByTestId("workspace-tab-file_target.ts")).not.toBeVisible();
      await expect(
        page.getByTestId(`workspace-tab-agent_${session.agentId}`).filter({ visible: true }),
      ).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("opens an HTML line target as source", async ({ page }) => {
    const target = "plan.html:2";
    const session = await seedAgentWithFileLink({
      target,
      fileName: "plan.html",
      content: [
        "<!doctype html>",
        "<h1>Review this source line</h1>",
        '<script>document.body.textContent = "This HTML executed";</script>',
      ].join("\n"),
    });

    try {
      await openAgentRoute(page, session);
      await page.getByText(target, { exact: true }).click();

      await expectFileTabOpen(page, "plan.html");
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(page.getByLabel("Line 2, column 1")).toBeVisible();
      await expect(page.getByTestId("file-html-preview")).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });

  test("shows the full file path and keeps editor controls stable", async ({
    page,
    withWorkspace,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const workspace = await withWorkspace({ prefix: "file-editing-visuals-" });
    const relativePath = "src/deep/visuals.md";
    const sourcePath = path.join(workspace.repoPath, relativePath);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      [...Array.from({ length: 11 }, (_, index) => `line ${index + 1}`), "abcdefghijklmnop"].join(
        "\n",
      ),
      "utf8",
    );
    await workspace.navigateTo();
    await openFileExplorer(page);
    await page.getByTestId("file-explorer-tree-scroll").getByText("src", { exact: true }).click();
    await page.getByTestId("file-explorer-tree-scroll").getByText("deep", { exact: true }).click();
    await openFileFromExplorer(page, "visuals.md");
    await expectFileTabOpen(page, relativePath);

    const fileTab = page.getByTestId(`workspace-tab-file_${relativePath}`).first();
    await fileTab.hover();
    await expect(page.getByTestId(`workspace-tab-tooltip-file_${relativePath}`)).toHaveText(
      relativePath,
    );
    await expect(page.getByTestId("file-panel-bar")).not.toContainText("visuals.md");
    const modeControl = page.getByTestId("file-preview-mode");
    await expect(modeControl).toBeVisible();
    await selectFileView(page, "Source");

    const editorHost = page.getByTestId("file-source-editor");
    const content = editor(page);
    await expect(editorHost).toHaveAttribute("data-pmono", "");
    await expect(content).toHaveCSS("font-family", /SFMono-Regular/);

    await content.click();
    const cursor = editorHost.locator(".cm-cursor-primary");
    await expect(cursor).toBeVisible();
    await expect(cursor).toHaveCSS("border-left-color", "rgb(250, 250, 250)");

    const initialModeBox = await modeControl.boundingBox();
    expect(initialModeBox).not.toBeNull();
    const initialModeX = initialModeBox!.x;
    await content.press("ControlOrMeta+End");
    await expect(page.getByLabel(/Line 12, column \d+/)).toBeVisible();
    const movedModeBox = await modeControl.boundingBox();
    expect(movedModeBox).not.toBeNull();
    expect(movedModeBox!.x).toBe(initialModeX);

    await content.press("ControlOrMeta+a");
    const selection = editorHost.locator(".cm-selectionBackground").first();
    await expect(selection).toBeVisible();
    await expect(selection).toHaveCSS("background-color", "rgba(255, 255, 255, 0.2)");
  });

  test("applies the interface font to portaled tooltips", async ({ page, withWorkspace }) => {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiFontFamily: "monospace" }));
    });
    const workspace = await withWorkspace({ prefix: "file-tooltip-font-" });
    const relativePath = "tooltip-font.txt";
    await writeFile(path.join(workspace.repoPath, relativePath), "tooltip font\n", "utf8");
    await workspace.navigateTo();
    await openFileExplorer(page);
    await openFileFromExplorer(page, relativePath);
    await expectFileTabOpen(page, relativePath);

    await page.getByTestId(`workspace-tab-file_${relativePath}`).first().hover();

    await expect(
      page
        .getByTestId(`workspace-tab-tooltip-file_${relativePath}`)
        .getByText(relativePath, { exact: true }),
    ).toHaveCSS("font-family", "monospace");
  });

  test("wraps Markdown while source code remains horizontally scrollable", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "file-editing-wrap-" });
    const longLine = "word ".repeat(300);
    await writeFile(path.join(workspace.repoPath, "notes.md"), `${longLine}\n`, "utf8");
    await writeFile(
      path.join(workspace.repoPath, "source.ts"),
      `const value = "${longLine}";\n`,
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "notes.md");
    await selectFileView(page, "Source");

    const markdownScroller = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator(".cm-scroller");
    await expect.poll(() => markdownScroller.evaluate(fitsViewportWidth)).toBe(true);

    await openWorkspaceFile(page, "source.ts");
    const sourceScroller = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator(".cm-scroller");
    await expect.poll(() => sourceScroller.evaluate(hasHorizontalOverflow)).toBe(true);
  });

  test("autosaves, saves immediately, resolves conflicts, and restores live updates after reconnect", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const workspace = await withWorkspace({ prefix: "file-editing-source-" });
    const sourcePath = path.join(workspace.repoPath, "source.ts");
    await writeFile(sourcePath, "const initial = 1;\n", "utf8");
    await Promise.all(
      ["one.ts", "two.ts", "three.ts", "four.ts"].map((fileName) =>
        writeFile(path.join(workspace.repoPath, fileName), `// ${fileName}\n`, "utf8"),
      ),
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "source.ts");

    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await expect(page.getByLabel(/File size/)).toBeVisible();
    await expect(page.getByLabel(/lines/)).toBeVisible();
    await expect(page.getByTestId("file-preview-mode")).toHaveCount(0);
    await expectAbove(
      page.getByTestId("file-panel-bar").filter({ visible: true }),
      page.getByTestId("file-source-editor").filter({ visible: true }),
    );

    await replaceEditorText(page, "const autosaved = 2;\n");
    await expect(page.getByTestId("workspace-tab-modified-file_source.ts")).toBeVisible();
    await expect(page.getByLabel("Editor status dirty")).toBeVisible();
    await expect(page.getByLabel("Editor status clean")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("workspace-tab-modified-file_source.ts")).not.toBeVisible();
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe("const autosaved = 2;\n");

    await replaceEditorText(page, "const immediate = 3;\n");
    await editor(page).press("Control+s");
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe("const immediate = 3;\n");

    await writeFile(sourcePath, "const external = 4;\nconst line = 2;\n", "utf8");
    await expect(editor(page)).toContainText("const external = 4;");
    await expect(page.getByLabel("3 lines")).toBeVisible();

    await replaceEditorText(page, "const localWins = 5;\n");
    await writeFile(sourcePath, "const diskLoses = 6;\n", "utf8");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    await page.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe("const localWins = 5;\n");
    for (const fileName of ["one.ts", "two.ts", "three.ts", "four.ts"]) {
      await openWorkspaceFile(page, fileName);
    }
    await openWorkspaceFile(page, "source.ts");
    await expect(editor(page)).toContainText("const localWins = 5;");

    await replaceEditorText(page, "const discarded = 7;\n");
    await writeFile(sourcePath, "const diskWins = 8;\n", "utf8");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(editor(page)).toContainText("const diskWins = 8;");

    const subscriptionCount = gate.getClientRequestCount("fs.file.subscribe.request");
    await gate.drop();
    gate.restore();
    await expect
      .poll(() => gate.getClientRequestCount("fs.file.subscribe.request"), { timeout: 30_000 })
      .toBeGreaterThan(subscriptionCount);
    await writeFile(sourcePath, "const afterReconnect = 9;\n", "utf8");
    await expect(editor(page)).toContainText("const afterReconnect = 9;");
  });

  test("preserves a UTF-8 BOM and uses the first line separator after saving", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "file-editing-encoding-" });
    const sourcePath = path.join(workspace.repoPath, "windows.ts");
    await writeFile(
      sourcePath,
      Buffer.from("\uFEFFconst initial = true;\r\nconst mixed = true;\n", "utf8"),
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "windows.ts");

    await replaceEditorText(page, "const saved = true;\nconst normalized = true;\n");
    await editor(page).press("Control+s");

    const expected = Buffer.from(
      "\uFEFFconst saved = true;\r\nconst normalized = true;\r\n",
      "utf8",
    ).toString("hex");
    await expect.poll(async () => (await readFile(sourcePath)).toString("hex")).toBe(expected);
  });

  test("warns before closing a panel with an unsaved draft", async ({ page, withWorkspace }) => {
    const workspace = await withWorkspace({ prefix: "file-editing-draft-" });
    const sourcePath = path.join(workspace.repoPath, "draft.ts");
    await writeFile(sourcePath, "const initial = 1;\n", "utf8");
    await workspace.navigateTo();
    await openWorkspaceFile(page, "draft.ts");

    await replaceEditorText(page, "const local = 2;\n");
    await writeFile(sourcePath, "const external = 3;\n", "utf8");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    await expect(page.getByTestId("workspace-tab-modified-file_draft.ts")).toBeVisible();

    let closePrompt = "";
    page.once("dialog", async (dialog) => {
      closePrompt = dialog.message();
      await dialog.dismiss();
    });
    await page
      .getByTestId("workspace-tab-file_draft.ts")
      .filter({ visible: true })
      .first()
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    expect(closePrompt).toContain("Closing it will discard the draft.");

    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await expect(page.getByTestId("workspace-tab-modified-file_draft.ts")).toBeVisible();
  });

  test("refreshes Markdown and images while preserving Preview and Source behavior", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const gate = await installDaemonWebSocketGate(page);
    const workspace = await withWorkspace({ prefix: "file-editing-preview-" });
    const markdownPath = path.join(workspace.repoPath, "notes.md");
    const imagePath = path.join(workspace.repoPath, "pixel.png");
    await writeFile(markdownPath, "# First heading\n", "utf8");
    await writeFile(imagePath, RED_PIXEL);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "notes.md");

    const visibleFilePane = page.getByTestId("workspace-file-pane").filter({ visible: true });
    const toolbar = page.getByTestId("file-panel-bar").filter({ visible: true });
    await expect(visibleFilePane.getByText("First heading", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
    await expect(toolbar.getByLabel(/^File size/)).toBeVisible();
    await expect(toolbar.getByLabel("2 lines")).toBeVisible();
    await writeFile(markdownPath, "# Updated heading\n", "utf8");
    await expect(visibleFilePane.getByText("Updated heading", { exact: true })).toBeVisible();

    // Source shows the same read in the editor; the file is not read again.
    const reads = fileReadCount(gate, "notes.md");
    await selectFileView(page, "Source");
    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await expect(editor(page)).toContainText("# Updated heading");
    await expect(toolbar.getByLabel("Line 1, column 1")).toBeVisible();
    expect(fileReadCount(gate, "notes.md")).toBe(reads);

    // Preview shows the edits made in Source.
    await replaceEditorText(page, "# Saved from source\n");
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeVisible();
    await selectFileView(page, "Preview");
    await expect(visibleFilePane.getByText("Saved from source", { exact: true })).toBeVisible();
    await expect(toolbar.getByLabel("Line 1, column 1")).toHaveCount(0);
    await expect.poll(() => readFile(markdownPath, "utf8")).toBe("# Saved from source\n");
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).not.toBeVisible();

    await openWorkspaceFile(page, "pixel.png");
    const image = visibleFilePane.locator("img");
    await expect(image).toBeVisible();
    const imageCanvas = page.getByTestId("image-file-preview-canvas");
    await expect(imageCanvas).toBeVisible();
    await imageCanvas.hover();
    const transformedContent = imageCanvas.locator(":scope > div").first();
    const fittedImageBox = await transformedContent.boundingBox();
    expect(fittedImageBox).not.toBeNull();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect
      .poll(async () => (await transformedContent.boundingBox())?.width ?? 0)
      .toBeGreaterThan(fittedImageBox!.width * 1.2);
    const initialSource = await image.getAttribute("src");
    await writeFile(imagePath, BLUE_PIXEL);
    await expect.poll(() => image.getAttribute("src")).not.toBe(initialSource);
  });

  test("renders local relative images inside Markdown preview", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-md-relative-image-" });
    await mkdir(path.join(workspace.repoPath, "docs"), { recursive: true });
    await mkdir(path.join(workspace.repoPath, "data", "cache"), { recursive: true });
    await writeFile(path.join(workspace.repoPath, "docs", "sibling.png"), RED_PIXEL);
    await writeFile(path.join(workspace.repoPath, "data", "cache", "hero.png"), RED_PIXEL);
    await writeFile(
      path.join(workspace.repoPath, "docs", "guide.md"),
      [
        "# Guide",
        "",
        "![sibling](./sibling.png)",
        "",
        "![hero](../data/cache/hero.png?v=2#preview)",
        "",
      ].join("\n"),
      "utf8",
    );
    await workspace.navigateTo();
    await openFileExplorer(page);
    await expandFolder(page, "docs");
    await openFileFromExplorer(page, "guide.md");
    await expectFileTabOpen(page, "docs/guide.md");

    const visibleFilePane = page.getByTestId("workspace-file-pane").filter({ visible: true });
    await expect(visibleFilePane.getByText("Guide", { exact: true })).toBeVisible();
    await expectMarkdownImageLoaded(page, "sibling");
    await expectMarkdownImageLoaded(page, "hero");
    await visibleFilePane.screenshot({
      path: test.info().outputPath("markdown-relative-images.png"),
    });
  });

  test("previews and refreshes an HTML plan while preserving source access", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-editing-html-preview-" });
    const htmlPath = path.join(workspace.repoPath, "plan.html");
    await writeFile(
      htmlPath,
      "<!doctype html><html><body><h1>Visual plan</h1></body></html>",
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "plan.html");

    const preview = htmlPreview(page);
    await expect(preview.host).toBeVisible();
    await expect(preview.host).toHaveAttribute("sandbox", /allow-scripts/);
    await expect(preview.host).not.toHaveAttribute("sandbox", /allow-same-origin/);
    await expect(preview.document.getByRole("heading", { name: "Visual plan" })).toBeVisible();

    await writeFile(
      htmlPath,
      "<!doctype html><html><body><h1>Updated plan</h1></body></html>",
      "utf8",
    );
    await expect(preview.document.getByRole("heading", { name: "Updated plan" })).toBeVisible();

    await selectFileView(page, "Source");
    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await expect(preview.host).toHaveCount(0);
    await selectFileView(page, "Preview");
    await expect(preview.host).toBeVisible();
  });

  test("keeps HTML fragment links in the preview and scrolls to the target", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "html-fragments-" });
    await writeFile(
      path.join(workspace.repoPath, "fragments.html"),
      `<!doctype html><html><body>
<a href="#section">Jump to section</a>
<div style="height: 1200px"></div>
<h2 id="section">Target section</h2>
</body></html>`,
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "fragments.html");

    const preview = htmlPreview(page);
    await expect(preview.document.getByRole("link", { name: "Jump to section" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("fragment-before-click.png") });
    await preview.document.getByRole("link", { name: "Jump to section" }).click();

    await expect(
      preview.document.getByRole("heading", { name: "Target section" }),
    ).toBeInViewport();
    expect(await preview.document.locator("body").evaluate(() => location.hash)).toBe("#section");
    expect(await preview.document.locator("body").evaluate(() => window.scrollY)).toBeGreaterThan(
      0,
    );
    await page.screenshot({ path: test.info().outputPath("fragment-after-click.png") });
  });

  test("lets an HTML page prevent fragment navigation", async ({ page, withWorkspace }) => {
    const workspace = await withWorkspace({ prefix: "html-fragment-handler-" });
    await writeFile(
      path.join(workspace.repoPath, "handled.html"),
      `<!doctype html><html><body>
<a href="#section" onclick="event.preventDefault(); document.querySelector('output').textContent = 'Page handled click'">Handled jump</a>
<output>Waiting for click</output>
<div style="height: 1200px"></div><h2 id="section">Target section</h2>
</body></html>`,
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "handled.html");

    const preview = htmlPreview(page);
    await preview.document.getByRole("link", { name: "Handled jump" }).click();
    await expect(preview.document.locator("output")).toHaveText("Page handled click");
    await expect(
      preview.document.getByRole("heading", { name: "Target section" }),
    ).not.toBeInViewport();
    expect(await preview.document.locator("body").evaluate(() => location.hash)).toBe("");
    expect(await preview.document.locator("body").evaluate(() => window.scrollY)).toBe(0);
  });

  test("respects delegated HTML fragment handlers and normal URL parsing", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "html-fragment-defaults-" });
    await writeFile(
      path.join(workspace.repoPath, "defaults.html"),
      `<!doctype html><html><body>
<nav style="position: fixed; top: 0; background: white">
<a href="#section" id="document-handler">Document handled jump</a>
<a href="#section" id="window-handler">Window handled jump</a>
<a href=" \t#section\n">Whitespace jump</a>
<a href="#100%">Percent jump</a>
<output>Waiting for click</output>
</nav>
<div style="height: 1200px"></div><h2 id="section">Target section</h2>
<div style="height: 1200px"></div><h2 id="100%">Percent target</h2>
<div style="height: 1200px"></div>
<script>
document.addEventListener('click', function(event) {
  if (event.target.id === 'document-handler') {
    event.preventDefault(); document.querySelector('output').textContent = 'Document handled click';
  }
});
window.addEventListener('click', function(event) {
  if (event.target.id === 'window-handler') {
    event.preventDefault(); document.querySelector('output').textContent = 'Window handled click';
  }
});
</script></body></html>`,
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "defaults.html");

    const preview = htmlPreview(page);
    await expectPageHandlesFragment(page, "Document");
    await expectPageHandlesFragment(page, "Window");

    await followHtmlPreviewLink(page, "Whitespace jump");
    await expect(
      preview.document.getByRole("heading", { name: "Target section" }),
    ).toBeInViewport();
    await followHtmlPreviewLink(page, "Percent jump");
    await expect(
      preview.document.getByRole("heading", { name: "Percent target" }),
    ).toBeInViewport();
  });

  test("handles HTML fragment targets, empty and missing fragments, and modified clicks", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "html-fragment-targets-" });
    await writeFile(
      path.join(workspace.repoPath, "targets.html"),
      `<!doctype html><html><head><style>:target { color: rgb(255, 0, 0); }</style></head><body>
<nav style="position: fixed; top: 0; background: white">
<a href="#section"><span>Nested jump</span></a>
<a href="#legacy">Named jump</a>
<a href="#encoded%20section">Encoded jump</a>
<a href="#missing">Missing jump</a>
<a href="#">Empty jump</a>
<output>Waiting for hashchange</output><output id="modified">Waiting for modified click</output>
</nav>
<div style="height: 1200px"></div><h2 id="section">Target section</h2>
<div style="height: 1200px"></div><a name="legacy">Named target</a>
<div style="height: 1200px"></div><h2 id="encoded section">Encoded target</h2>
<div style="height: 1200px"></div>
<script>
window.addEventListener('hashchange', function () { document.querySelector('output').textContent = location.hash || '(empty)'; });
function modifiedClick(event) {
  if (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
    document.getElementById('modified').textContent = String(event.defaultPrevented);
    event.preventDefault();
  }
}
window.addEventListener('click', modifiedClick);
window.addEventListener('auxclick', modifiedClick);
window.addEventListener('contextmenu', modifiedClick);
</script></body></html>`,
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "targets.html");

    const preview = htmlPreview(page);
    const body = preview.document.locator("body");
    const nested = preview.document.getByText("Nested jump", { exact: true });
    await nested.click();
    await expect(preview.document.locator("output").first()).toHaveText("#section");
    await expect(
      preview.document.getByRole("heading", { name: "Target section" }),
    ).toBeInViewport();
    await expect(preview.document.locator("#section")).toHaveCSS("color", "rgb(255, 0, 0)");

    await body.evaluate(() => window.scrollTo(0, 0));
    await nested.click();
    await expect(
      preview.document.getByRole("heading", { name: "Target section" }),
    ).toBeInViewport();

    await preview.document.getByRole("link", { name: "Named jump" }).click();
    await expect(preview.document.getByText("Named target", { exact: true })).toBeInViewport();
    await expect(preview.document.locator("output").first()).toHaveText("#legacy");

    await preview.document.getByRole("link", { name: "Encoded jump" }).click();
    await expect(
      preview.document.getByRole("heading", { name: "Encoded target" }),
    ).toBeInViewport();
    await expect(preview.document.locator("output").first()).toHaveText("#encoded%20section");
    const scrollY = await body.evaluate(() => window.scrollY);
    await preview.document.getByRole("link", { name: "Missing jump" }).click();
    expect(await body.evaluate(() => location.hash)).toBe("#missing");
    expect(await body.evaluate(() => window.scrollY)).toBe(scrollY);

    await preview.document.getByRole("link", { name: "Empty jump" }).click();
    await expect(preview.document.locator("output").first()).toHaveText("(empty)");
    expect(await body.evaluate(() => window.scrollY)).toBe(0);

    for (const modifier of ["Control", "Meta", "Shift", "Alt"] as const) {
      await nested.click({ modifiers: [modifier] });
      await expect(preview.document.locator("#modified")).toHaveText("false");
    }
    await nested.click({ button: "middle" });
    await expect(preview.document.locator("#modified")).toHaveText("false");
    expect(await body.evaluate(() => location.hash)).toBe("");
    expect(await body.evaluate(() => window.scrollY)).toBe(0);
  });

  test("runs inline scripts without allowing fetch egress", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-editing-html-csp-" });
    await writeFile(
      path.join(workspace.repoPath, "probe.html"),
      `<!doctype html><html><head><title>probe</title></head><body>
<h1 id="script-result">Inline script did not run</h1>
<p id="network-result">Network request not attempted</p>
<p id="document-mode">Standards mode not detected</p>
<script>
  document.getElementById("script-result").textContent = "Inline script ran";
  if (document.compatMode === "CSS1Compat") {
    document.getElementById("document-mode").textContent = "Standards mode enabled";
  }
  var networkResult = document.getElementById("network-result");
  fetch("${BLOCKED_PREVIEW_URL}", { method: "POST", body: "repo-content" })
    .then(function () { networkResult.textContent = "Network request allowed"; })
    .catch(function () { networkResult.textContent = "Network request blocked"; });
</script>
</body></html>`,
      "utf8",
    );
    await workspace.navigateTo();

    const blockedRequests = watchRequestsTo(page, BLOCKED_PREVIEW_URL);

    await openWorkspaceFile(page, "probe.html");

    const preview = htmlPreview(page);
    await expect(
      preview.document.getByRole("heading", { name: "Inline script ran" }),
    ).toBeVisible();
    await expect(
      preview.document.getByText("Standards mode enabled", { exact: true }),
    ).toBeVisible();
    await expect(
      preview.document.getByText("Network request blocked", { exact: true }),
    ).toBeVisible();
    expect(blockedRequests).toEqual([]);
  });

  test("isolates HTML plans from the app origin and storage", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-editing-html-origin-" });
    await writeFile(
      path.join(workspace.repoPath, "origin.html"),
      `<!doctype html><html><body>
<p id="parent">?</p><p id="storage">?</p><p id="cookie">?</p>
<script>
  function report(id, label, probe) {
    try { probe(); document.getElementById(id).textContent = label + " reachable"; }
    catch (error) { document.getElementById(id).textContent = label + " blocked"; }
  }
  report("parent", "Parent DOM", function () { return parent.document.body; });
  report("storage", "Storage", function () { return localStorage.length; });
  report("cookie", "Cookies", function () { return document.cookie; });
</script>
</body></html>`,
      "utf8",
    );
    await workspace.navigateTo();
    await openWorkspaceFile(page, "origin.html");

    const preview = htmlPreview(page);
    await expect(preview.document.getByText("Parent DOM blocked", { exact: true })).toBeVisible();
    await expect(preview.document.getByText("Storage blocked", { exact: true })).toBeVisible();
    await expect(preview.document.getByText("Cookies blocked", { exact: true })).toBeVisible();
  });

  test("persists Vim keybindings and reports Vim mode with cursor position", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-editing-vim-" });
    await writeFile(path.join(workspace.repoPath, "vim.ts"), "const vim = true;\n", "utf8");

    await page.goto("/settings/editor");
    const toggle = page.getByRole("switch", { name: "Vim keybindings" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await page.reload();
    await expect(page.getByRole("switch", { name: "Vim keybindings" })).toBeChecked();

    await workspace.navigateTo();
    await openWorkspaceFile(page, "vim.ts");
    await expect(page.getByLabel("Vim mode NORMAL")).toBeVisible();
    await expect(page.getByLabel("Line 1, column 1")).toBeVisible();
    await editor(page).click();
    await editor(page).press("i");
    await expect(page.getByLabel("Vim mode INSERT")).toBeVisible();
    await editor(page).press("Escape");
    await expect(page.getByLabel("Vim mode NORMAL")).toBeVisible();
  });
});

async function openAssistantMarkdownLink(page: Page, name: string): Promise<void> {
  await page.getByRole("link", { name, exact: true }).first().click();
}

async function returnToAssistant(page: Page, agentId: string): Promise<void> {
  await page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).click();
}

async function openAssistantInlinePath(page: Page, token: string): Promise<void> {
  await page.getByText(token, { exact: true }).click();
}

async function expectPreviewText(page: Page, text: string): Promise<void> {
  await expect(
    page
      .getByTestId("workspace-file-pane")
      .filter({ visible: true })
      .getByText(text, { exact: true }),
  ).toBeVisible();
}
