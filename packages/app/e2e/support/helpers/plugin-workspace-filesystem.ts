import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { gotoWorkspace } from "./launcher";
import { connectNewWorkspaceDaemonClient, openProjectViaDaemon } from "./new-workspace";
import {
  expectExplorerEntryHidden,
  expectExplorerEntryVisible,
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "./file-explorer";
import { pluginRequirements } from "./plugin-fixture";

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

type Client = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

export class PluginWorkspaceFileSystemHarness {
  private constructor(
    private readonly page: Page,
    private readonly root: string,
    private readonly backingFile: string,
    private readonly workspaceId: string,
    private readonly projectId: string,
    private readonly client: Client,
    private readonly previousPluginsEnabled: boolean,
  ) {}

  static async create(page: Page): Promise<PluginWorkspaceFileSystemHarness> {
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
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(plugin);
    const opened = await openProjectViaDaemon(client, workspace);
    return new PluginWorkspaceFileSystemHarness(
      page,
      root,
      backingFile,
      opened.workspaceId,
      opened.projectId,
      client,
      previousConfig.config.pluginsEnabled ?? false,
    );
  }

  async openRemoteFile(): Promise<void> {
    await gotoWorkspace(this.page, this.workspaceId);
    await openFileExplorer(this.page);
    await expectExplorerEntryVisible(this.page, "remote.txt");
    await expectExplorerEntryHidden(this.page, "LOCAL_ONLY.txt");
    await openFileFromExplorer(this.page, "remote.txt");
    await expectFileTabOpen(this.page, "remote.txt");
  }

  async replaceRemoteText(content: string): Promise<void> {
    await writeFile(this.backingFile, content, "utf8");
  }

  async expectEditorText(content: string): Promise<void> {
    await expect(this.editor()).toContainText(content, { timeout: 10_000 });
  }

  async saveEditorText(content: string): Promise<void> {
    await this.editor().fill(content);
    await this.editor().press("Control+s");
  }

  async expectRemoteText(content: string): Promise<void> {
    await expect.poll(() => readFile(this.backingFile, "utf8")).toBe(content);
  }

  async dispose(): Promise<void> {
    await this.client.removeProject(this.projectId).catch(() => undefined);
    await this.client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await this.client
      .patchDaemonConfig({ pluginsEnabled: this.previousPluginsEnabled })
      .catch(() => undefined);
    await this.client.close().catch(() => undefined);
    await rm(this.root, { recursive: true, force: true });
  }

  private editor() {
    return this.page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator(".cm-content");
  }
}
