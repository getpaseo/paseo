import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import {
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

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
  const contentElement = editor(page);
  await contentElement.click();
  await contentElement.press("Control+A");
  await contentElement.type(content);
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

async function selectFileView(page: Page, view: "Preview" | "Source"): Promise<void> {
  const option = page.getByTestId("file-panel-bar").getByRole("button", {
    name: view,
    exact: true,
  });
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
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
      await sourceEditor.press("Control+Home");
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
      await page.setViewportSize({ width: 1280, height: 900 });
      await openAgentRoute(page, session);

      await page.getByRole("button", { name: "Split pane right" }).first().click();
      await expect(page.getByTestId("workspace-tabs-row").filter({ visible: true })).toHaveCount(2);
      await openWorkspaceFile(page, "target.ts");

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
    await content.press("Control+End");
    await expect(page.getByLabel(/Line 12, column \d+/)).toBeVisible();
    const movedModeBox = await modeControl.boundingBox();
    expect(movedModeBox).not.toBeNull();
    expect(movedModeBox!.x).toBe(initialModeX);

    await content.press("Control+a");
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
    for (const fileName of ["one.ts", "two.ts", "three.ts", "four.ts"]) {
      await openWorkspaceFile(page, fileName);
    }
    await page.getByTestId("workspace-tab-file_source.ts").filter({ visible: true }).click();
    await expect(editor(page)).toContainText("const localWins = 5;");
    await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
    await page.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect.poll(() => readFile(sourcePath, "utf8")).toBe("const localWins = 5;\n");

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
    await page
      .getByTestId("workspace-tab-context-file_draft.ts-close")
      .filter({ visible: true })
      .click();
    expect(closePrompt).toContain("Closing it will discard the draft.");

    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await expect(page.getByTestId("workspace-tab-modified-file_draft.ts")).toBeVisible();
  });

  test("refreshes Markdown and images while preserving Preview and Source behavior", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "file-editing-preview-" });
    const markdownPath = path.join(workspace.repoPath, "notes.md");
    const imagePath = path.join(workspace.repoPath, "pixel.png");
    await writeFile(markdownPath, "# First heading\n", "utf8");
    await writeFile(imagePath, RED_PIXEL);
    await workspace.navigateTo();
    await openWorkspaceFile(page, "notes.md");

    await expect(page.getByText("First heading", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
    await writeFile(markdownPath, "# Updated heading\n", "utf8");
    await expect(page.getByText("Updated heading", { exact: true })).toBeVisible();

    await selectFileView(page, "Source");
    await expect(page.getByTestId("file-source-editor")).toBeVisible();
    await replaceEditorText(page, "# Saved from source\n");
    await expect.poll(() => readFile(markdownPath, "utf8")).toBe("# Saved from source\n");
    await selectFileView(page, "Preview");
    await expect(page.getByText("Saved from source", { exact: true })).toBeVisible();

    await openWorkspaceFile(page, "pixel.png");
    const image = page.getByTestId("workspace-file-pane").locator("img");
    await expect(image).toBeVisible();
    const initialSource = await image.getAttribute("src");
    await writeFile(imagePath, BLUE_PIXEL);
    await expect.poll(() => image.getAttribute("src")).not.toBe(initialSource);
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
