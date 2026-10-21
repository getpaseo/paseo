import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";

const PLUGIN_ID = "file-panel-e2e";
const PDF = Buffer.from("%PDF-1.4\n%\x00\xff\n1 0 obj<</Type/Catalog>>endobj\n%%EOF", "binary");
const SOURCE = `import React, { useEffect, useState } from "react";
import { Text, View, Pressable } from "react-native";
import {
  PluginFileConflictError,
  useFileBytes,
  useFileUrl,
  usePaseo,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { DocumentFrame, Loading } from "@getpaseo/plugin/client/ui";
function Pdf({ file, workspaceId }) {
  usePaseo();
  useQueryClient();
  const workspace = useWorkspace(workspaceId, value => ({ id: value.id }));
  const bytes = useFileBytes(file);
  const url = useFileUrl(file);
  const [urlBytes, setUrlBytes] = useState(-1);
  const href = url.status === "ready" ? url.url : null;
  useEffect(() => {
    if (href) fetch(href).then(response => response.arrayBuffer()).then(body => setUrlBytes(body.byteLength));
  }, [href]);
  if (bytes.status !== "ready" || !href) return <Loading />;
  return <View style={{ flex: 1 }}>
    <Text>PDF plugin: {file.name}</Text>
    <Text>Path {file.path}</Text>
    <Text>Bytes {bytes.bytes.length}; URL bytes {urlBytes}</Text>
    <Text>Workspace {workspace?.id}</Text>
    <DocumentFrame url={href} testID="plugin-pdf-frame" />
  </View>;
}
// Reads once and writes on demand, so a change on disk since that read rejects the write.
function Markdown({ file, tab }) {
  const [text, setText] = useState(null);
  const [status, setStatus] = useState("");
  useEffect(() => { file.readText().then(setText); }, [file]);
  const save = (next) => {
    tab.setModified(true);
    file.writeText(next).then(
      () => { tab.setModified(false); setText(next); },
      (error) => setStatus(error instanceof PluginFileConflictError ? "Write rejected: changed on disk" : String(error)),
    );
  };
  if (text === null) return <Loading />;
  return <View>
    <Text>Plugin Markdown: {text}</Text>
    <Pressable accessibilityRole="button" onPress={() => save("# Saved by plugin\\n")}>
      <Text>Edit Markdown through plugin</Text>
    </Pressable>
    <Text>{status}</Text>
  </View>;
}
export default function contribute(client) {
  client.addFilePanel({ id: "pdf", title: "PDF", icon: "FileText",
    files: { extensions: ["pdf", "txt"] }, Component: Pdf });
  client.addFilePanel({ id: "markdown", title: "Plugin Markdown", icon: "FileText",
    files: { extensions: ["md"] }, Component: Markdown });
  return () => {};
}`;

async function openWorkspaceFile(page: Page, name: string) {
  await openFileFromExplorer(page, name);
  await expectFileTabOpen(page, name);
}
async function associateMarkdownWithPlugin(page: Page) {
  await page.evaluate(() => {
    const key = "@paseo:app-settings";
    const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
    settings.filePanelAssociations = { "ext:md": "plugin:file-panel-e2e/markdown" };
    localStorage.setItem(key, JSON.stringify(settings));
  });
  await page.reload();
}
async function editMarkdownThroughPlugin(page: Page) {
  await page.getByRole("button", { name: "Edit Markdown through plugin", exact: true }).click();
}
async function selectSource(page: Page) {
  await page
    .getByTestId("file-panel-switcher")
    .filter({ visible: true })
    .getByRole("button", { name: "Source", exact: true })
    .click();
}

test("directory plugins render PDF bytes and write Markdown through the file handle", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-file-panels-plugin-"));
  const workspace = await seedWorkspace({
    repoPrefix: "file-panels-",
    repo: {
      files: [
        { path: "notes.md", content: "# Built-in Markdown\n" },
        { path: "bytes.txt", content: "Bytes panel text document" },
      ],
    },
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  await writeFile(path.join(workspace.repoPath, "report.pdf"), PDF);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), SOURCE);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1280, height: 900 });
    const gate = await installDaemonWebSocketGate(page);
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openWorkspaceFile(page, "report.pdf");
    await expect(page.getByText("PDF plugin: report.pdf", { exact: true })).toBeVisible();
    await expect(
      page.getByText(`Bytes ${PDF.length}; URL bytes ${PDF.length}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Workspace ${workspace.workspaceId}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByTitle("Document preview", { exact: true })).toHaveAttribute(
      "src",
      /^blob:/,
    );
    await expect(
      page.getByText(`Path ${path.join(workspace.repoPath, "report.pdf")}`, { exact: true }),
    ).toBeVisible();
    const pdfScreenshot = testInfo.outputPath("plugin-pdf-web.png");
    await page.screenshot({ path: pdfScreenshot });
    await testInfo.attach("plugin-pdf-web", { path: pdfScreenshot, contentType: "image/png" });

    // A plugin panel claiming a text file competes with Source, so Paseo asks over the plugin.
    await openWorkspaceFile(page, "bytes.txt");
    await expect(page.getByText("Open .txt files with", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Open .txt files with", { exact: true })).toBeHidden();
    await expect(page.getByText("PDF plugin: bytes.txt", { exact: true })).toBeVisible();
    await expect(page.getByTitle("Document preview", { exact: true })).toBeVisible();
    await expect(page.getByTitle("Document preview", { exact: true })).toHaveAttribute(
      "sandbox",
      "",
    );
    await expect(
      page
        .frameLocator('[title="Document preview"]')
        .getByText("Bytes panel text document", { exact: true }),
    ).toBeVisible();

    await openWorkspaceFile(page, "notes.md");
    await expect(page.getByText("Open .md files with", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Open .md files with", { exact: true })).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Built-in Markdown", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit Markdown through plugin" })).toHaveCount(0);
    await associateMarkdownWithPlugin(page);
    await expect(
      page.getByText("Plugin Markdown: # Built-in Markdown", { exact: true }),
    ).toBeVisible();
    gate.holdNextClientRequest("fs.file.write.request");
    await editMarkdownThroughPlugin(page);
    await gate.waitForHeldClientRequest();
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeVisible();
    gate.releaseHeldClientRequest();
    await expect(
      page.getByText("Plugin Markdown: # Saved by plugin", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "notes.md"), "utf8"))
      .toBe("# Saved by plugin\n");
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeHidden();

    // The disk changed since the plugin's last read or write: the write is rejected, not applied.
    await writeFile(path.join(workspace.repoPath, "notes.md"), "# Changed outside\n");
    await editMarkdownThroughPlugin(page);
    await expect(page.getByText("Write rejected: changed on disk", { exact: true })).toBeVisible();
    expect(await readFile(path.join(workspace.repoPath, "notes.md"), "utf8")).toBe(
      "# Changed outside\n",
    );
    await expect(page.getByTestId("workspace-tab-modified-file_notes.md")).toBeVisible();
    let closePrompt = "";
    page.once("dialog", async (dialog) => {
      closePrompt = dialog.message();
      await dialog.dismiss();
    });
    await page
      .getByTestId("workspace-tab-file_notes.md")
      .filter({ visible: true })
      .first()
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect.poll(() => closePrompt).toContain("discard");

    await selectSource(page);
    await expect(
      page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-content"),
    ).toHaveText("# Changed outside");
    const markdownScreenshot = testInfo.outputPath("plugin-markdown-source-web.png");
    await page.screenshot({ path: markdownScreenshot });
    await testInfo.attach("plugin-markdown-source-web", {
      path: markdownScreenshot,
      contentType: "image/png",
    });
  } finally {
    await client.removePlugin(PLUGIN_ID);
    await client.patchDaemonConfig({
      pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
    });
    await client.close();
    await workspace.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
