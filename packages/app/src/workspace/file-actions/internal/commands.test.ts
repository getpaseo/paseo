import { describe, expect, it } from "vitest";
import { createWorkspaceFileCommands, type WorkspaceFileCommandsHost } from "./commands";

class FakeHost implements WorkspaceFileCommandsHost {
  readonly clipboard: string[] = [];
  readonly copied: string[] = [];
  readonly failures: string[] = [];
  readonly revealedInFileManager: string[] = [];
  readonly openedInDefaultApp: string[] = [];
  readonly downloads: { cwd: string; path: string; fileName: string }[] = [];
  readonly revealedInFiles: string[] = [];
  readonly existingEntries = new Set<string>(["src/data/report.csv", "src/data"]);

  workspaceRoot = "/repo";
  fileManager: WorkspaceFileCommandsHost["fileManager"] = {
    name: "Finder",
    reveal: async (path) => {
      this.revealedInFileManager.push(path);
    },
  };
  defaultApp: WorkspaceFileCommandsHost["defaultApp"] = async (path) => {
    this.openedInDefaultApp.push(path);
  };

  writeClipboard = async (text: string) => {
    this.clipboard.push(text);
  };
  notifyCopied: WorkspaceFileCommandsHost["notifyCopied"] = (what) => {
    this.copied.push(what);
  };
  notifyFailure: WorkspaceFileCommandsHost["notifyFailure"] = (failure) => {
    this.failures.push(failure);
  };
  download: WorkspaceFileCommandsHost["download"] = (input) => {
    this.downloads.push(input);
  };
  revealInFiles = async (relativePath: string) => {
    if (!this.existingEntries.has(relativePath)) return false;
    this.revealedInFiles.push(relativePath);
    return true;
  };
}

function actionIds(host: FakeHost, path: string, kind: "file" | "directory" = "file") {
  return createWorkspaceFileCommands(host)
    .actionsFor(path, kind)
    .map((action) => action.id);
}

describe("workspace file actions", () => {
  it("offers every action for a workspace file on a local desktop host", () => {
    expect(actionIds(new FakeHost(), "src/data/report.csv")).toEqual([
      "reveal-in-files",
      "reveal-in-file-manager",
      "open-in-default-app",
      "download",
      "copy-path",
      "copy-relative-path",
    ]);
  });

  it("omits desktop actions when the host cannot reach the local filesystem", () => {
    const host = new FakeHost();
    host.fileManager = null;
    host.defaultApp = null;

    expect(actionIds(host, "src/data/report.csv")).toEqual([
      "reveal-in-files",
      "download",
      "copy-path",
      "copy-relative-path",
    ]);
  });

  it("omits workspace-only actions for a file outside the workspace", () => {
    expect(actionIds(new FakeHost(), "~/Downloads/report.csv")).toEqual([
      "reveal-in-file-manager",
      "open-in-default-app",
      "download",
      "copy-path",
    ]);
    expect(actionIds(new FakeHost(), "/tmp/report.csv")).toEqual([
      "reveal-in-file-manager",
      "open-in-default-app",
      "download",
      "copy-path",
    ]);
  });

  it("does not offer to open or download a directory", () => {
    expect(actionIds(new FakeHost(), "src/data", "directory")).toEqual([
      "reveal-in-files",
      "reveal-in-file-manager",
      "copy-path",
      "copy-relative-path",
    ]);
  });

  it("copies the absolute and the workspace-relative path and confirms each", async () => {
    const host = new FakeHost();
    const commands = createWorkspaceFileCommands(host);

    await commands.copyPath("src/data/report.csv");
    await commands.copyRelativePath("/repo/src/data/report.csv");
    await commands.copyPath("~/Downloads/report.csv");

    expect(host.clipboard).toEqual([
      "/repo/src/data/report.csv",
      "src/data/report.csv",
      "~/Downloads/report.csv",
    ]);
    expect(host.copied).toEqual(["path", "relativePath", "path"]);
  });

  it("keeps Windows separators in a copied absolute path", async () => {
    const host = new FakeHost();
    host.workspaceRoot = "C:\\repo";

    await createWorkspaceFileCommands(host).copyPath("src/data/report.csv");

    expect(host.clipboard).toEqual(["C:\\repo\\src\\data\\report.csv"]);
  });

  it("reports a clipboard failure instead of confirming a copy", async () => {
    const host = new FakeHost();
    host.writeClipboard = async () => {
      throw new Error("denied");
    };

    await createWorkspaceFileCommands(host).copyPath("src/data/report.csv");

    expect(host.copied).toEqual([]);
    expect(host.failures).toEqual(["copy"]);
  });

  it("hands absolute paths to the file manager and the default app", async () => {
    const host = new FakeHost();
    const commands = createWorkspaceFileCommands(host);

    await commands.revealInFileManager("src/data/report.csv");
    await commands.openInDefaultApp("~/Downloads/report.csv");

    expect(host.revealedInFileManager).toEqual(["/repo/src/data/report.csv"]);
    expect(host.openedInDefaultApp).toEqual(["~/Downloads/report.csv"]);
  });

  it("reveals an entry in a workspace rooted at the filesystem root", async () => {
    const host = new FakeHost();
    host.workspaceRoot = "/";

    await createWorkspaceFileCommands(host).revealInFileManager("usr/bin");

    expect(host.revealedInFileManager).toEqual(["/usr/bin"]);
  });

  it("reports a failed desktop action", async () => {
    const host = new FakeHost();
    host.fileManager = {
      name: "Finder",
      reveal: async () => {
        throw new Error("gone");
      },
    };
    host.defaultApp = async () => {
      throw new Error("no application");
    };
    const commands = createWorkspaceFileCommands(host);

    await commands.revealInFileManager("src/data/report.csv");
    await commands.openInDefaultApp("src/data/report.csv");

    expect(host.failures).toEqual(["revealInFileManager", "openInDefaultApp"]);
  });

  it("downloads from the directory that can serve the file", () => {
    const host = new FakeHost();
    const commands = createWorkspaceFileCommands(host);

    commands.download("src/data/report.csv");
    commands.download("/tmp/other.csv");

    expect(host.downloads).toEqual([
      { cwd: "/repo", path: "src/data/report.csv", fileName: "report.csv" },
      { cwd: "/", path: "/tmp/other.csv", fileName: "other.csv" },
    ]);
  });

  it("reveals a workspace file in Files by its relative path", async () => {
    const host = new FakeHost();

    await createWorkspaceFileCommands(host).revealInFiles("/repo/src/data/report.csv");

    expect(host.revealedInFiles).toEqual(["src/data/report.csv"]);
    expect(host.failures).toEqual([]);
  });

  it("says why a file cannot be revealed in Files", async () => {
    const host = new FakeHost();
    const commands = createWorkspaceFileCommands(host);

    await commands.revealInFiles("/tmp/report.csv");
    await commands.revealInFiles("src/deleted.csv");

    expect(host.revealedInFiles).toEqual([]);
    expect(host.failures).toEqual(["outsideWorkspace", "notFoundInFiles"]);
  });
});
