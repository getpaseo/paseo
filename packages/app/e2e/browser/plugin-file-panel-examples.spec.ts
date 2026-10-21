import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoWorkspace } from "../support/helpers/launcher";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";

// Full Chromium includes the PDF viewer; the default headless shell does not.
test.use({ channel: "chromium" });

function samplePdf() {
  const stream = "BT /F1 24 Tf 72 720 Td (Paseo PDF panel example) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n%\u0000\u00ff\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

async function openFile(page: Page, name: string) {
  await openFileFromExplorer(page, name);
  await expectFileTabOpen(page, name);
}

const WIDE = { width: 1280, height: 900 };
const COMPACT = { width: 390, height: 844 };

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

/** Captures the current state wide, then compact once `ready` holds there, and returns to wide. */
async function captureWideAndCompact(
  page: Page,
  testInfo: TestInfo,
  name: string,
  ready: () => Promise<void>,
) {
  await capture(page, testInfo, `${name}-wide`);
  // The shell survives the breakpoint, so the previous layout's copy can still be on screen right
  // after a resize. Check `ready` only once the shell reports the new layout.
  await page.setViewportSize(COMPACT);
  await expect(page.getByTestId("compact-shell")).toBeVisible();
  await ready();
  await capture(page, testInfo, `${name}-compact`);
  await page.setViewportSize(WIDE);
  await expect(page.getByTestId("wide-shell")).toBeVisible();
  await ready();
}

function filePanelSwitcher(page: Page) {
  return page.getByTestId("file-panel-switcher").filter({ visible: true });
}

/** Turns on vim keybindings without discarding settings the test writes later. */
async function enableVimKeybindings(page: Page) {
  await page.addInitScript(() => {
    const key = "@paseo:app-settings";
    const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...settings, vimKeybindings: true }));
  });
}

async function chooseRichMarkdown(page: Page) {
  await page.getByRole("radio", { name: "Rich Markdown — markdown-panel", exact: true }).click();
  await page.getByRole("checkbox", { name: "Don't ask me again", exact: true }).click();
  await page.getByRole("button", { name: "Use", exact: true }).click();
}

async function replaceMarkdown(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Rich Markdown editor", exact: true }).fill(text);
}

async function selectPanel(page: Page, title: string) {
  await filePanelSwitcher(page).getByRole("button", { name: title, exact: true }).click();
}

async function expectPanels(page: Page, titles: string[]) {
  for (const title of titles) {
    await expect(
      filePanelSwitcher(page).getByRole("button", { name: title, exact: true }),
    ).toBeInViewport({ ratio: 1 });
  }
}

/** The browser's PDF viewer in the mounted frame; a remounted pane leaves old frames detached. */
async function pdfViewer(page: Page): Promise<Frame> {
  const viewerUrl = /^chrome-extension:\/\/[^/]+\/index\.html$/;
  const find = () =>
    page.frames().find((frame) => !frame.isDetached() && viewerUrl.test(frame.url())) ?? null;
  await expect.poll(() => find() !== null).toBe(true);
  return find()!;
}

async function expectPdfViewerReady(page: Page) {
  // A narrow viewer collapses its toolbar to Print and More actions.
  const viewer = await pdfViewer(page);
  await expect(viewer.getByRole("button", { name: "Print", exact: true })).toBeEnabled();
}

async function expectMarkdownEditor(page: Page, text: string) {
  const editor = page.getByRole("textbox", { name: "Rich Markdown editor", exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText(text);
  await expect(editor).toBeInViewport({ ratio: 1 });
  // Side by side on a wide screen; on a phone three panels do not fit, so the switcher is a menu.
  await expect(filePanelSwitcher(page)).toContainText("Rich Markdown");
  await expect(filePanelSwitcher(page)).toBeInViewport({ ratio: 1 });
}

test("directory examples mount the PDF frame and write Markdown through the file handle", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const pdf = await copyPluginExample("pdf-panel");
  const markdown = await copyPluginExample("markdown-panel");
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: markdown.directory, stdio: "pipe" },
  );
  const workspace = await seedWorkspace({
    repoPrefix: "file-panel-examples-",
    repo: {
      files: [
        {
          path: "notes.md",
          content: "# Markdown panel example\n\nEdit **Markdown** through Paseo.\n",
        },
        { path: "second.md", content: "# Remembered panel\n" },
        { path: "report.pdf", content: samplePdf() },
      ],
    },
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pdf.directory);
    await client.installDirectoryPlugin(markdown.directory);
    await enableVimKeybindings(page);
    await page.setViewportSize(WIDE);
    const gate = await installDaemonWebSocketGate(page);
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openFile(page, "report.pdf");
    await expect(page.getByTitle("Document preview", { exact: true })).toHaveAttribute(
      "src",
      /^blob:/,
    );
    await expect(page.getByTitle("Document preview", { exact: true })).not.toHaveAttribute(
      "sandbox",
    );
    const documentUrl = await page
      .getByTitle("Document preview", { exact: true })
      .getAttribute("src");
    expect(
      await page.evaluate(
        async (url) => (await fetch(url!)).blob().then((blob) => blob.type),
        documentUrl,
      ),
    ).toBe("application/pdf");
    await expectPdfViewerReady(page);
    await expect(
      (await pdfViewer(page)).getByRole("textbox", { name: "Page number", exact: true }),
    ).toHaveValue("1");
    await captureWideAndCompact(page, testInfo, "pdf-example", async () => {
      await expect(page.getByTitle("Document preview", { exact: true })).toBeInViewport();
      await expectPdfViewerReady(page);
    });

    await openFile(page, "notes.md");
    await expect(page.getByRole("radio", { name: "Markdown — Paseo", exact: true })).toBeChecked();
    await expect(
      page.getByRole("radio", { name: "Rich Markdown — markdown-panel", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: "Source — Paseo", exact: true })).toBeVisible();
    await captureWideAndCompact(page, testInfo, "markdown-example-picker", async () => {
      // The previous layout's picker animates out (the sheet slides down, the dialog fades), so
      // both pickers are mounted for a moment after a resize.
      await expect(page.getByRole("button", { name: "Use", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Use", exact: true })).toBeInViewport({
        ratio: 1,
      });
    });
    await chooseRichMarkdown(page);
    await expect(page.getByRole("textbox", { name: "Rich Markdown editor" })).toContainText(
      "Markdown panel example",
    );
    gate.holdNextClientRequest("fs.file.write.request");
    await replaceMarkdown(page, "# Edited by Rich Markdown\n\nSaved by the panel.\n");
    await gate.waitForHeldClientRequest();
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeVisible();
    await capture(page, testInfo, "markdown-example-dirty-wide");
    gate.releaseHeldClientRequest();
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "notes.md"), "utf8"))
      .toBe("# Edited by Rich Markdown\n\nSaved by the panel.\n");
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeHidden();
    await expectPanels(page, ["Rich Markdown", "Markdown", "Source"]);
    await captureWideAndCompact(page, testInfo, "markdown-example-rich-markdown", async () => {
      await expectMarkdownEditor(page, "Edited by Rich Markdown");
    });

    // Source is Paseo's editor; its cursor and vim mode are in its own status row.
    await selectPanel(page, "Source");
    const source = page.getByTestId("file-source-editor").filter({ visible: true });
    await expect(source.locator(".cm-content")).toContainText("Edited by Rich Markdown");
    await source.locator(".cm-line").nth(2).click();
    const bar = page.getByTestId("file-source-status").filter({ visible: true });
    await expect(bar.getByText("NORMAL", { exact: true })).toBeVisible();
    await expect(bar.getByText(/^Ln 3, Col \d+$/)).toBeVisible();
    await capture(page, testInfo, "markdown-example-source-wide");
    // The phone layout mounts the tab anew, so it opens the remembered panel; its menu offers Source.
    await page.setViewportSize(COMPACT);
    await expect(filePanelSwitcher(page)).toHaveText("Rich Markdown");
    await filePanelSwitcher(page).click();
    await page.getByRole("menuitem", { name: "Source", exact: true }).click();
    await expect(filePanelSwitcher(page)).toHaveText("Source");
    await source.locator(".cm-line").nth(2).click();
    await expect(bar.getByText("NORMAL", { exact: true })).toBeInViewport();
    await expect(bar.getByText(/^Ln 3, Col \d+$/)).toBeInViewport();
    await capture(page, testInfo, "markdown-example-source-compact");
    await page.setViewportSize(WIDE);
    await selectPanel(page, "Rich Markdown");
    await writeFile(path.join(workspace.repoPath, "notes.md"), "# External update\n");
    await expect(page.getByRole("textbox", { name: "Rich Markdown editor" })).toHaveText(
      "# External update",
    );
    await replaceMarkdown(page, "# Local edit\n");
    await writeFile(path.join(workspace.repoPath, "notes.md"), "# Conflicting external edit\n");
    await expect(page.getByTestId("rich-markdown-conflict")).toBeVisible();
    await capture(page, testInfo, "markdown-example-conflict-wide");
    await page.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "notes.md"), "utf8"))
      .toBe("# Local edit\n");

    await openFile(page, "second.md");
    await expect(page.getByRole("textbox", { name: "Rich Markdown editor" })).toContainText(
      "Remembered panel",
    );
    await expect(page.getByText("Open .md files with", { exact: true })).toBeHidden();
    await page.setViewportSize(COMPACT);
    await expectMarkdownEditor(page, "Remembered panel");
    await expect(filePanelSwitcher(page)).toHaveText("Rich Markdown");
  } finally {
    await client.removePlugin("pdf-panel");
    await client.removePlugin("markdown-panel");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await workspace.cleanup();
    await pdf.cleanup();
    await markdown.cleanup();
  }
});
