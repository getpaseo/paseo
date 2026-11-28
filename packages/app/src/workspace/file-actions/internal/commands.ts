import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

export type WorkspaceFileKind = "file" | "directory";

export type WorkspaceFileActionId =
  | "reveal-in-files"
  | "reveal-in-file-manager"
  | "open-in-default-app"
  | "download"
  | "copy-path"
  | "copy-relative-path";

export interface WorkspaceFileAction {
  id: WorkspaceFileActionId;
  run: () => void;
}

export type WorkspaceFileActionFailure =
  | "copy"
  | "revealInFileManager"
  | "openInDefaultApp"
  | "outsideWorkspace"
  | "notFoundInFiles";

/** Everything the actions need from the surrounding app. */
export interface WorkspaceFileCommandsHost {
  workspaceRoot: string;
  /** Null when this client cannot reach the host's file manager. */
  fileManager: { name: string; reveal: (absolutePath: string) => Promise<void> } | null;
  /** Null when this client cannot open files in the host's applications. */
  defaultApp: ((absolutePath: string) => Promise<void>) | null;
  writeClipboard: (text: string) => Promise<void>;
  notifyCopied: (what: "path" | "relativePath") => void;
  notifyFailure: (failure: WorkspaceFileActionFailure, cause?: unknown) => void;
  download: (input: { cwd: string; path: string; fileName: string }) => void;
  /** Resolves false when the entry is no longer in the workspace tree. */
  revealInFiles: (relativePath: string) => Promise<boolean>;
}

export interface WorkspaceFileCommands {
  revealTargetName: string | null;
  /** The actions that apply to one path, in menu order. */
  actionsFor: (path: string, kind: WorkspaceFileKind) => WorkspaceFileAction[];
  copyPath: (path: string) => Promise<void>;
  copyRelativePath: (path: string) => Promise<void>;
  revealInFileManager: (path: string) => Promise<void>;
  openInDefaultApp: (path: string) => Promise<void>;
  download: (path: string) => void;
  revealInFiles: (path: string) => Promise<void>;
}

export function createWorkspaceFileCommands(
  host: WorkspaceFileCommandsHost,
): WorkspaceFileCommands {
  const { workspaceRoot } = host;

  // The desktop expands `~` itself; the client does not know the host's home directory.
  const absolutePathOf = (path: string) =>
    path === "~" || path.startsWith("~/")
      ? path
      : buildAbsoluteExplorerPath({ workspaceRoot, entryPath: path });

  const relativePathOf = (path: string) =>
    resolveWorkspaceFilePaths({ path, workspaceRoot })?.relativePath ?? null;

  async function copy(text: string, what: "path" | "relativePath") {
    try {
      await host.writeClipboard(text);
    } catch (cause) {
      host.notifyFailure("copy", cause);
      return;
    }
    host.notifyCopied(what);
  }

  const commands: WorkspaceFileCommands = {
    revealTargetName: host.fileManager?.name ?? null,

    copyPath: (path) => copy(absolutePathOf(path), "path"),

    async copyRelativePath(path) {
      const relativePath = relativePathOf(path);
      if (relativePath) await copy(relativePath, "relativePath");
    },

    async revealInFileManager(path) {
      try {
        await host.fileManager?.reveal(absolutePathOf(path));
      } catch (cause) {
        host.notifyFailure("revealInFileManager", cause);
      }
    },

    async openInDefaultApp(path) {
      try {
        await host.defaultApp?.(absolutePathOf(path));
      } catch (cause) {
        host.notifyFailure("openInDefaultApp", cause);
      }
    },

    download(path) {
      const target = resolveFilePreviewReadTarget({ path, workspaceRoot });
      if (!target) return;
      host.download({ ...target, fileName: path.split(/[\\/]/).pop() || path });
    },

    async revealInFiles(path) {
      const relativePath = relativePathOf(path);
      if (!relativePath) {
        host.notifyFailure("outsideWorkspace");
        return;
      }
      if (!(await host.revealInFiles(relativePath))) {
        host.notifyFailure("notFoundInFiles");
      }
    },

    actionsFor(path, kind) {
      const inWorkspace = relativePathOf(path) !== null;
      const isFile = kind === "file";
      const candidates: [WorkspaceFileActionId, boolean, () => unknown][] = [
        ["reveal-in-files", inWorkspace, () => commands.revealInFiles(path)],
        [
          "reveal-in-file-manager",
          host.fileManager !== null,
          () => commands.revealInFileManager(path),
        ],
        [
          "open-in-default-app",
          isFile && host.defaultApp !== null,
          () => commands.openInDefaultApp(path),
        ],
        ["download", isFile, () => commands.download(path)],
        ["copy-path", true, () => commands.copyPath(path)],
        ["copy-relative-path", inWorkspace, () => commands.copyRelativePath(path)],
      ];
      return candidates
        .filter(([, available]) => available)
        .map(([id, , run]) => ({ id, run: () => void run() }));
    },
  };

  return commands;
}
