import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

/**
 * End-to-end proof that workspace transfers ride the WebSocket binary channel.
 *
 * These run against a real daemon over a real socket, so they exercise the whole
 * path: fs.entry.download.request, the FileBegin/Chunk/End frames, the ack window,
 * and the daemon writing an upload into the workspace tree.
 *
 * Screenshots land in e2e/artifacts/ as QA evidence.
 */

const ARTIFACTS = path.join(__dirname, "..", "artifacts");
let workspace: SeededWorkspace;

test.beforeEach(async () => {
  workspace = await seedWorkspace({ repoPrefix: "workspace-file-transfer-" });
});

test.afterEach(async () => {
  await workspace?.cleanup();
});

test("downloads a file over the binary channel with byte-identical content", async ({ page }) => {
  // Every byte value, so a chunking or encoding fault shows up as a mismatch.
  const fixture = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  await writeFile(path.join(workspace.repoPath, "payload.bin"), fixture);

  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const tree = page.getByTestId("file-explorer-tree-scroll");
  const entry = (name: string) => tree.getByText(name, { exact: true }).first();
  await expect(entry("payload.bin")).toBeVisible();

  await entry("payload.bin").click({ button: "right" });
  await page.screenshot({ path: path.join(ARTIFACTS, "01-file-context-menu.png") });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByText("Download", { exact: true }).click(),
  ]);

  expect(download.suggestedFilename()).toBe("payload.bin");
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const received = await readFile(downloadedPath!);
  expect(received.byteLength).toBe(fixture.byteLength);
  expect(received.equals(fixture)).toBe(true);

  await page.screenshot({ path: path.join(ARTIFACTS, "02-file-downloaded.png") });
});

test("preserves a non-ASCII filename through a download", async ({ page }) => {
  const fileName = "設計ノート.md";
  await writeFile(path.join(workspace.repoPath, fileName), "# 設計\n");

  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const tree = page.getByTestId("file-explorer-tree-scroll");
  await expect(tree.getByText(fileName, { exact: true }).first()).toBeVisible();
  await tree.getByText(fileName, { exact: true }).first().click({ button: "right" });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByText("Download", { exact: true }).click(),
  ]);

  // The HTTP path mangled CJK via Content-Disposition; the WS path must not.
  expect(download.suggestedFilename()).toBe(fileName);
  await page.screenshot({ path: path.join(ARTIFACTS, "03-cjk-filename-download.png") });
});

test("downloads a folder as a zip containing the tree", async ({ page }) => {
  const siteDir = path.join(workspace.repoPath, "site");
  await mkdir(path.join(siteDir, "assets"), { recursive: true });
  await writeFile(path.join(siteDir, "index.html"), "<h1>hello</h1>");
  await writeFile(path.join(siteDir, "assets", "logo.svg"), "<svg/>");

  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const tree = page.getByTestId("file-explorer-tree-scroll");
  await expect(tree.getByText("site", { exact: true }).first()).toBeVisible();
  await tree.getByText("site", { exact: true }).first().click({ button: "right" });
  await page.screenshot({ path: path.join(ARTIFACTS, "04-folder-context-menu.png") });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByText("Download", { exact: true }).click(),
  ]);

  expect(download.suggestedFilename()).toBe("site.zip");
  const zipPath = await download.path();
  const zip = await JSZip.loadAsync(await readFile(zipPath!));
  expect(Object.keys(zip.files).sort()).toEqual(["assets/logo.svg", "index.html"]);
  expect(await zip.file("index.html")?.async("string")).toBe("<h1>hello</h1>");

  await page.screenshot({ path: path.join(ARTIFACTS, "05-folder-zip-downloaded.png") });
});

test("uploads a file into a workspace folder", async ({ page }) => {
  await mkdir(path.join(workspace.repoPath, "assets"), { recursive: true });
  await writeFile(path.join(workspace.repoPath, "assets", ".keep"), "");

  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const tree = page.getByTestId("file-explorer-tree-scroll");
  await expect(tree.getByText("assets", { exact: true }).first()).toBeVisible();
  await tree.getByText("assets", { exact: true }).first().click({ button: "right" });
  await page.screenshot({ path: path.join(ARTIFACTS, "06-upload-menu-on-folder.png") });

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Upload files…", { exact: true }).click(),
  ]);
  await chooser.setFiles({
    name: "uploaded.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded through the binary channel"),
  });

  // The authoritative check: the daemon actually wrote the bytes into the workspace tree.
  const uploadedPath = path.join(workspace.repoPath, "assets", "uploaded.txt");
  await expect
    .poll(async () => readFile(uploadedPath, "utf8").catch(() => null), { timeout: 20_000 })
    .toBe("uploaded through the binary channel");

  // Then confirm the explorer surfaces it, which needs the folder expanded.
  await tree.getByText("assets", { exact: true }).first().click();
  await expect(tree.getByText("uploaded.txt", { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });

  await page.screenshot({ path: path.join(ARTIFACTS, "07-file-uploaded.png") });
});

test("uploading a name that already exists keeps both files", async ({ page }) => {
  await mkdir(path.join(workspace.repoPath, "assets"), { recursive: true });
  await writeFile(path.join(workspace.repoPath, "assets", "logo.txt"), "original");

  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const tree = page.getByTestId("file-explorer-tree-scroll");
  await tree.getByText("assets", { exact: true }).first().click({ button: "right" });

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Upload files…", { exact: true }).click(),
  ]);
  await chooser.setFiles({
    name: "logo.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded"),
  });

  // "rename" on collision: the original must survive untouched.
  await expect
    .poll(
      async () =>
        readFile(path.join(workspace.repoPath, "assets", "logo (1).txt"), "utf8").catch(() => null),
      { timeout: 20_000 },
    )
    .toBe("uploaded");
  expect(await readFile(path.join(workspace.repoPath, "assets", "logo.txt"), "utf8")).toBe(
    "original",
  );

  await tree.getByText("assets", { exact: true }).first().click();
  await expect(tree.getByText("logo (1).txt", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: path.join(ARTIFACTS, "08-upload-collision-renamed.png") });
});

test("uploads a non-ASCII filename into the workspace unchanged", async ({ page }) => {
  const fileName = "設計ノート 🗂.md";
  await mkdir(path.join(workspace.repoPath, "docs"), { recursive: true });
  await writeFile(path.join(workspace.repoPath, "docs", ".keep"), "");

  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const tree = page.getByTestId("file-explorer-tree-scroll");
  await tree.getByText("docs", { exact: true }).first().click({ button: "right" });

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Upload files…", { exact: true }).click(),
  ]);
  await chooser.setFiles({
    name: fileName,
    mimeType: "text/markdown",
    buffer: Buffer.from("# 設計\n"),
  });

  await expect
    .poll(
      async () =>
        readFile(path.join(workspace.repoPath, "docs", fileName), "utf8").catch(() => null),
      { timeout: 20_000 },
    )
    .toBe("# 設計\n");

  await page.screenshot({ path: path.join(ARTIFACTS, "09-cjk-upload.png") });
});

test("offers a cancel control while a transfer is in flight", async ({ page }) => {
  // Large enough that the toast is still showing when we look for the control.
  await writeFile(path.join(workspace.repoPath, "large.bin"), Buffer.alloc(48 * 1024 * 1024, 7));

  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const tree = page.getByTestId("file-explorer-tree-scroll");
  await tree.getByText("large.bin", { exact: true }).first().click({ button: "right" });

  const downloadPromise = page.waitForEvent("download");
  await page.getByText("Download", { exact: true }).click();

  // The cancel control only renders while inFlight, so finding it proves the in-progress state.
  const cancel = page.getByTestId("transfer-toast-cancel");
  await expect(cancel).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: path.join(ARTIFACTS, "10-transfer-in-progress.png") });

  await downloadPromise;
  await expect(cancel).toBeHidden({ timeout: 20_000 });
});
