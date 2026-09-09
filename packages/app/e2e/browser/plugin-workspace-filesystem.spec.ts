import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import {
  expectExplorerEntryHidden,
  expectExplorerEntryVisible,
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";
import { pluginRequirements } from "../support/helpers/plugin-fixture";

const PLUGIN_ID = "workspace-filesystem-e2e";

function pluginSource(input: { workspace: string; backingFile: string }): string {
  return `import { readFile, stat, writeFile } from "node:fs/promises";

const workspace = ${JSON.stringify(input.workspace)};
const backingFile = ${JSON.stringify(input.backingFile)};

async function version(path) {
  const metadata = await stat(backingFile);
  return {
    status: "ready",
    cwd: workspace,
    path,
    size: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
    revision: String(metadata.mtimeMs) + ":" + String(metadata.size),
  };
}

export default function contribute(server) {
  server.registerWorkspaceFileSystem({
    id: "example.remote",
    matches: ({ cwd }) => cwd === workspace,
    async listDirectory({ path }) {
      if (path !== ".") throw new Error("Directory not found: " + path);
      const metadata = await stat(backingFile);
      return {
        path,
        entries: [{
          name: "remote.txt",
          path: "remote.txt",
          kind: "file",
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        }],
      };
    },
    async readFile({ path }) {
      if (path !== "remote.txt") throw new Error("File not found: " + path);
      const [content, current] = await Promise.all([readFile(backingFile, "utf8"), version(path)]);
      return {
        path,
        kind: "text",
        encoding: "utf-8",
        content,
        mimeType: "text/plain",
        size: current.size,
        modifiedAt: current.modifiedAt,
        revision: current.revision,
      };
    },
    statFile: ({ path }) => version(path),
    async writeFile({ path, content, expectedRevision }) {
      const current = await version(path);
      if (expectedRevision && expectedRevision !== current.revision) {
        return { status: "conflict", version: current };
      }
      await writeFile(backingFile, content, "utf8");
      const written = await version(path);
      return {
        status: "written",
        modifiedAt: written.modifiedAt,
        size: written.size,
        revision: written.revision,
      };
    },
  });
  return () => {};
}`;
}

function editor(page: Parameters<typeof openFileExplorer>[0]) {
  return page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-content");
}

test("plugin files use the native Explorer, file tab, and editor", async ({ page }) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-workspace-filesystem-e2e-"));
  const workspace = path.join(root, "workspace-anchor");
  const plugin = path.join(root, "plugin");
  const backingFile = path.join(root, "remote.txt");
  await Promise.all([
    writeFile(backingFile, "remote initial\n", "utf8"),
    mkdir(workspace),
    mkdir(plugin),
  ]);
  await writeFile(path.join(workspace, "LOCAL_ONLY.txt"), "must stay hidden\n", "utf8");
  await writeFile(
    path.join(plugin, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(plugin, "index.server.ts"), pluginSource({ workspace, backingFile }));

  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  let projectId: string | null = null;
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(plugin);
    const opened = await openProjectViaDaemon(client, workspace);
    projectId = opened.projectId;

    await gotoWorkspace(page, opened.workspaceId);
    await openFileExplorer(page);
    await expectExplorerEntryVisible(page, "remote.txt");
    await expectExplorerEntryHidden(page, "LOCAL_ONLY.txt");
    await openFileFromExplorer(page, "remote.txt");
    await expectFileTabOpen(page, "remote.txt");
    await expect(editor(page)).toContainText("remote initial");

    await writeFile(backingFile, "remote external\n", "utf8");
    await expect(editor(page)).toContainText("remote external", { timeout: 10_000 });

    await editor(page).fill("saved through native editor\n");
    await editor(page).press("Control+s");
    await expect.poll(() => readFile(backingFile, "utf8")).toBe("saved through native editor\n");
  } finally {
    if (projectId) await client.removeProject(projectId).catch(() => undefined);
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
