import { useCallback, useMemo, type ReactElement } from "react";
import React from "react";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { useToast } from "@/contexts/toast-context";
import { openDesktopTarget, useFileManagerOpenTarget } from "@/workspace/desktop-open-targets";
import {
  resolveWorkspaceFilePaths,
  toNativeAbsolutePath,
  type OpenFileDisposition,
} from "@/workspace/file-open";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkSource } from "./resolver";

interface AssistantFileLinkContextMenuContentProps {
  source: AssistantFileLinkSource;
  target: InlinePathTarget;
  serverId: string;
  workspaceRoot?: string;
  onOpen: (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => void;
  testIDPrefix?: string;
}

/**
 * Right-click actions for a file path inside an assistant message. Mirrors the diff pane's
 * per-file menu (see FileActionsContextMenuContent) for links whose target resolves without
 * a daemon lookup.
 */
export function AssistantFileLinkContextMenuContent({
  source,
  target,
  serverId,
  workspaceRoot,
  onOpen,
  testIDPrefix,
}: AssistantFileLinkContextMenuContentProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  // Reveal and editor opens run on this machine, so a remote daemon's paths must not
  // reach the local file manager.
  const fileManagerTarget = useFileManagerOpenTarget(serverId);

  const resolvedPaths = useMemo(
    () => (workspaceRoot ? resolveWorkspaceFilePaths({ path: target.path, workspaceRoot }) : null),
    [target.path, workspaceRoot],
  );

  const absolutePath = useMemo(() => {
    if (resolvedPaths) {
      return toNativeAbsolutePath(resolvedPaths.absolutePath);
    }
    const rawPath = target.path;
    if (isAbsoluteRawPath(rawPath) || rawPath.startsWith("~/")) {
      return toNativeAbsolutePath(rawPath);
    }
    return null;
  }, [resolvedPaths, target.path]);
  const copyPath = useCallback(() => {
    if (!absolutePath) {
      return;
    }
    Clipboard.setStringAsync(absolutePath).catch((error) => {
      console.warn("[assistant-file-link] copy path failed", error);
    });
  }, [absolutePath]);

  const copyRelativePath = useCallback(() => {
    if (!resolvedPaths?.relativePath) {
      return;
    }
    Clipboard.setStringAsync(resolvedPaths.relativePath).catch((error) => {
      console.warn("[assistant-file-link] copy relative path failed", error);
    });
  }, [resolvedPaths]);

  const reveal = useCallback(() => {
    if (!fileManagerTarget || !absolutePath) {
      return;
    }
    void openDesktopTarget({
      editorId: fileManagerTarget.id,
      workspacePath: workspaceRoot ?? "",
      filePath: absolutePath,
    }).catch((error) => {
      console.warn("[assistant-file-link] reveal failed", error);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("workspace.fileExplorer.errors.revealFailed"),
      );
    });
  }, [absolutePath, fileManagerTarget, t, toast, workspaceRoot]);

  const openFile = useCallback(() => onOpen(source, "preferred"), [onOpen, source]);
  const openToSide = useCallback(() => onOpen(source, "side"), [onOpen, source]);

  return (
    <FileActionsContextMenuContent
      fileKind="file"
      onOpenFile={openFile}
      onOpenToSide={openToSide}
      onCopyPath={absolutePath ? copyPath : undefined}
      onCopyRelativePath={resolvedPaths?.relativePath ? copyRelativePath : undefined}
      onReveal={fileManagerTarget && absolutePath ? reveal : undefined}
      revealTargetName={fileManagerTarget?.label}
      testIDPrefix={testIDPrefix}
    />
  );
}

function isAbsoluteRawPath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}
