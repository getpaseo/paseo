import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { useSessionStore } from "@/stores/session-store";
import type { ExplorerEntry } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { confirmDialog } from "@/utils/confirm-dialog";
import { copyFilePathsAsFilesystemItems, revealItemInFolder } from "@/desktop/shell";
import { getIsElectron } from "@/constants/platform";
import { getExplorerParentPath } from "@/file-explorer/paths";
import { isElectronRuntimeMac } from "@/desktop/host";

export type ExplorerNamePromptKind = "new-file" | "new-folder" | "rename";

export interface ExplorerNamePromptState {
  kind: ExplorerNamePromptKind;
  parentPath: string;
  initialValue: string;
  targetPath?: string;
}

interface UseFileExplorerCommandsInput {
  serverId: string;
  workspaceRoot: string;
  canMutate: boolean;
  isLocalDaemon: boolean;
  onOpenFile?: (filePath: string) => void;
  refreshPaths: (paths: string[]) => Promise<void>;
  selectExplorerEntry: (path: string | null) => void;
}

export function useFileExplorerCommands(input: UseFileExplorerCommandsInput) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const [namePrompt, setNamePrompt] = useState<ExplorerNamePromptState | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const cwd = input.workspaceRoot.trim();
  const isDesktop = getIsElectron();
  const canUseLocalShell = isDesktop && input.isLocalDaemon;

  const revealLabel = useMemo(() => {
    if (isElectronRuntimeMac()) {
      return t("workspace.fileExplorer.context.revealInFinder");
    }
    const platform = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (/Windows/i.test(platform)) {
      return t("workspace.fileExplorer.context.revealInExplorer");
    }
    return t("workspace.fileExplorer.context.revealInFiles");
  }, [t]);

  const absolutePathFor = useCallback(
    (entryPath: string) =>
      buildAbsoluteExplorerPath({
        workspaceRoot: cwd,
        entryPath,
      }),
    [cwd],
  );

  const requireClient = useCallback(() => {
    if (!client) {
      throw new Error(t("workspace.terminal.hostDisconnected"));
    }
    return client;
  }, [client, t]);

  const requireMutateClient = useCallback(() => {
    const daemon = requireClient();
    if (!input.canMutate) {
      throw new Error(t("workspace.fileExplorer.toasts.updateHostToMutate"));
    }
    return daemon;
  }, [input.canMutate, requireClient, t]);

  const runAction = useCallback(
    async (actionId: string, run: () => Promise<void>) => {
      if (pendingAction) {
        return;
      }
      setPendingAction(actionId);
      try {
        await run();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("common.errors.unableToSave"));
      } finally {
        setPendingAction(null);
      }
    },
    [pendingAction, t, toast],
  );

  const copyAbsolutePath = useCallback(
    async (entryPath: string) => {
      await Clipboard.setStringAsync(absolutePathFor(entryPath));
      toast.copied();
    },
    [absolutePathFor, toast],
  );

  const copyRelativePath = useCallback(
    async (entryPath: string) => {
      await Clipboard.setStringAsync(entryPath.trim());
      toast.copied();
    },
    [toast],
  );

  const copyContents = useCallback(
    async (entry: ExplorerEntry) => {
      await runAction(`copy-contents:${entry.path}`, async () => {
        const daemon = requireClient();
        const file = await daemon.readFile(cwd, entry.path);
        if (file.kind !== "text") {
          throw new Error(t("workspace.fileExplorer.toasts.copyContentsBinary"));
        }
        const text = new TextDecoder().decode(file.bytes);
        await Clipboard.setStringAsync(text);
        toast.copied();
      });
    },
    [cwd, requireClient, runAction, t, toast],
  );

  const copyAsFilesystemItem = useCallback(
    async (entryPath: string) => {
      if (!canUseLocalShell) {
        toast.error(t("workspace.fileExplorer.toasts.localOnly"));
        return;
      }
      await runAction(`copy-item:${entryPath}`, async () => {
        await copyFilePathsAsFilesystemItems([absolutePathFor(entryPath)]);
        toast.copied();
      });
    },
    [absolutePathFor, canUseLocalShell, runAction, t, toast],
  );

  const reveal = useCallback(
    async (entryPath: string) => {
      if (!canUseLocalShell) {
        toast.error(t("workspace.fileExplorer.toasts.localOnly"));
        return;
      }
      await runAction(`reveal:${entryPath}`, async () => {
        await revealItemInFolder(absolutePathFor(entryPath));
      });
    },
    [absolutePathFor, canUseLocalShell, runAction, t, toast],
  );

  const openNewFilePrompt = useCallback((parentPath: string) => {
    setNamePrompt({
      kind: "new-file",
      parentPath,
      initialValue: "untitled.txt",
    });
  }, []);

  const openNewFolderPrompt = useCallback((parentPath: string) => {
    setNamePrompt({
      kind: "new-folder",
      parentPath,
      initialValue: "untitled folder",
    });
  }, []);

  const openRenamePrompt = useCallback((entry: ExplorerEntry) => {
    setNamePrompt({
      kind: "rename",
      parentPath: getExplorerParentPath(entry.path),
      initialValue: entry.name,
      targetPath: entry.path,
    });
  }, []);

  const closeNamePrompt = useCallback(() => {
    setNamePrompt(null);
  }, []);

  const submitNamePrompt = useCallback(
    async (name: string) => {
      if (!namePrompt) {
        return;
      }
      const trimmed = name.trim();
      await runAction(`name-prompt:${namePrompt.kind}`, async () => {
        const daemon = requireMutateClient();
        if (namePrompt.kind === "new-file" || namePrompt.kind === "new-folder") {
          const entry = await daemon.createExplorerEntry({
            cwd,
            parentPath: namePrompt.parentPath,
            name: trimmed,
            kind: namePrompt.kind === "new-file" ? "file" : "directory",
          });
          await input.refreshPaths([namePrompt.parentPath]);
          input.selectExplorerEntry(entry.path);
          if (namePrompt.kind === "new-file") {
            input.onOpenFile?.(entry.path);
          }
          toast.show(t("workspace.fileExplorer.toasts.created"), { variant: "success" });
          setNamePrompt(null);
          return;
        }

        if (!namePrompt.targetPath) {
          throw new Error(t("common.errors.unableToSave"));
        }
        const entry = await daemon.renameExplorerEntry({
          cwd,
          path: namePrompt.targetPath,
          newName: trimmed,
        });
        await input.refreshPaths([namePrompt.parentPath, getExplorerParentPath(entry.path)]);
        input.selectExplorerEntry(entry.path);
        toast.show(t("workspace.fileExplorer.toasts.renamed"), { variant: "success" });
        setNamePrompt(null);
      });
    },
    [cwd, input, namePrompt, requireMutateClient, runAction, t, toast],
  );

  const duplicate = useCallback(
    async (entry: ExplorerEntry) => {
      await runAction(`duplicate:${entry.path}`, async () => {
        const daemon = requireMutateClient();
        const created = await daemon.duplicateExplorerEntry({ cwd, path: entry.path });
        await input.refreshPaths([getExplorerParentPath(entry.path)]);
        input.selectExplorerEntry(created.path);
        toast.show(t("workspace.fileExplorer.toasts.duplicated"), { variant: "success" });
      });
    },
    [cwd, input, requireMutateClient, runAction, t, toast],
  );

  const deleteEntry = useCallback(
    async (entry: ExplorerEntry) => {
      const confirmed = await confirmDialog({
        title: t("workspace.fileExplorer.confirm.deleteTitle"),
        message: t("workspace.fileExplorer.confirm.deleteMessage", { name: entry.name }),
        confirmLabel: t("workspace.fileExplorer.context.delete"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await runAction(`delete:${entry.path}`, async () => {
        const daemon = requireMutateClient();
        const parentPath = getExplorerParentPath(entry.path);
        await daemon.deleteExplorerEntry({ cwd, path: entry.path });
        await input.refreshPaths([parentPath]);
        input.selectExplorerEntry(null);
        toast.show(t("workspace.fileExplorer.toasts.deleted"), { variant: "success" });
      });
    },
    [cwd, input, requireMutateClient, runAction, t, toast],
  );

  const viewFile = useCallback(
    (entry: ExplorerEntry) => {
      if (entry.kind !== "file") {
        return;
      }
      input.selectExplorerEntry(entry.path);
      input.onOpenFile?.(entry.path);
    },
    [input],
  );

  const createParentForTarget = useCallback((entry: ExplorerEntry) => {
    if (entry.kind === "directory") {
      return entry.path;
    }
    return getExplorerParentPath(entry.path);
  }, []);

  return useMemo(
    () => ({
      namePrompt,
      pendingAction,
      canMutate: input.canMutate,
      canUseLocalShell,
      revealLabel,
      copyAbsolutePath,
      copyRelativePath,
      copyContents,
      copyAsFilesystemItem,
      reveal,
      openNewFilePrompt,
      openNewFolderPrompt,
      openRenamePrompt,
      closeNamePrompt,
      submitNamePrompt,
      duplicate,
      deleteEntry,
      viewFile,
      createParentForTarget,
    }),
    [
      namePrompt,
      pendingAction,
      input.canMutate,
      canUseLocalShell,
      revealLabel,
      copyAbsolutePath,
      copyRelativePath,
      copyContents,
      copyAsFilesystemItem,
      reveal,
      openNewFilePrompt,
      openNewFolderPrompt,
      openRenamePrompt,
      closeNamePrompt,
      submitNamePrompt,
      duplicate,
      deleteEntry,
      viewFile,
      createParentForTarget,
    ],
  );
}
