import { useCallback, useMemo, type ReactNode } from "react";
import type { ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { AppWindow, Copy, ExternalLink, FolderOpen, Globe } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import { getIsElectron } from "@/constants/platform";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { usePaneContext } from "@/panels/pane-context";
import type { Theme } from "@/styles/theme";
import { isAbsolutePath } from "@/utils/path";
import { openExternalUrl } from "@/utils/open-external-url";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import { parentDirectory } from "@/workspace/open-in-file-manager/tab-file-actions";
import { useAssistantFileLinkResolverContext } from "./provider";
import { classifyForResolution } from "./resolver";
import type { AssistantFileLinkSource } from "./resolver";
import type { InlinePathTarget } from "./parse";
import { resolveLinkMenuTarget } from "./link-menu-target";

const ThemedAppWindow = withUnistyles(AppWindow);
const ThemedGlobe = withUnistyles(Globe);
const ThemedCopy = withUnistyles(Copy);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedFolderOpen = withUnistyles(FolderOpen);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const LEADING_SIZE = 15;

export function LinkContextMenu({
  source,
  resolvedTarget,
  children,
}: {
  source: AssistantFileLinkSource;
  /** The target the click path resolved (null while a daemon lookup is pending). */
  resolvedTarget: InlinePathTarget | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const pane = usePaneContext();
  const isElectron = getIsElectron();
  const { configRef } = useAssistantFileLinkResolverContext();
  const workspaceRoot = configRef.current.workspaceRoot ?? "";
  const serverId = configRef.current.serverId ?? "";
  const resolution = useMemo(
    () => classifyForResolution(source, { workspaceRoot }),
    [source, workspaceRoot],
  );
  const target = useMemo(
    () => resolveLinkMenuTarget(resolution, resolvedTarget),
    [resolution, resolvedTarget],
  );
  // Precomputed so the menu items pass elements, not inline JSX props.
  const leading = useMemo(
    () => ({
      paseo: <ThemedAppWindow size={LEADING_SIZE} uniProps={mutedColorMapping} />,
      browser: <ThemedGlobe size={LEADING_SIZE} uniProps={mutedColorMapping} />,
      copy: <ThemedCopy size={LEADING_SIZE} uniProps={mutedColorMapping} />,
      defaultApp: <ThemedExternalLink size={LEADING_SIZE} uniProps={mutedColorMapping} />,
      reveal: <ThemedFolderOpen size={LEADING_SIZE} uniProps={mutedColorMapping} />,
    }),
    [],
  );
  const isLocalExecution = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution });
  const fileManagerTarget = useMemo(
    () => targets.find((candidate) => candidate.kind === "file-manager") ?? null,
    [targets],
  );
  const absolutePath = useMemo(() => {
    if (target?.kind !== "file") {
      return null;
    }
    // `~/...` has no workspace-relative form; only hand the OS something absolute.
    const resolved = workspaceRoot
      ? resolveWorkspaceFilePaths({ path: target.path, workspaceRoot })
      : null;
    if (resolved) {
      return resolved.absolutePath;
    }
    return isAbsolutePath(target.path) ? target.path : null;
  }, [target, workspaceRoot]);

  const openInPaseo = useCallback(() => {
    if (target?.kind !== "external" || !isElectron) return;
    const { browserId } = createWorkspaceBrowser({ initialUrl: target.url });
    pane.openTab({ kind: "browser", browserId });
  }, [isElectron, pane, target]);

  const openInBrowser = useCallback(() => {
    if (target?.kind !== "external") return;
    void openExternalUrl(target.url);
  }, [target]);

  const copyFilePath = useCallback(() => {
    if (!absolutePath) return;
    void Clipboard.setStringAsync(absolutePath)
      .then(() => toast.copied(t("workspace.tabs.toasts.filePathCopiedLabel")))
      .catch(() => toast.error(t("workspace.tabs.toasts.copyFailed")));
  }, [absolutePath, t, toast]);

  const runFileAction = useCallback(
    (action: (fileManagerId: string, path: string) => Promise<void>) => {
      if (!fileManagerTarget || !absolutePath) {
        toast.error(t("workspace.fileExplorer.errors.revealFailed"));
        return;
      }
      void action(fileManagerTarget.id, absolutePath).catch((cause: unknown) => {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      });
    },
    [absolutePath, fileManagerTarget, t, toast],
  );

  const openWithDefaultApp = useCallback(() => {
    runFileAction((editorId, path) => openDesktopTarget({ editorId, workspacePath: path }));
  }, [runFileAction]);

  const revealInFileManager = useCallback(() => {
    runFileAction((editorId, path) =>
      openDesktopTarget({
        editorId,
        workspacePath: parentDirectory(path),
        filePath: path,
      }),
    );
  }, [runFileAction]);

  if (!target) {
    return children;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger contextOnly style={LINK_MENU_TRIGGER_STYLE}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent align="start" width={240}>
        {target.kind === "external" ? (
          <>
            {isElectron ? (
              <ContextMenuItem
                testID="link-menu-open-in-paseo"
                leading={leading.paseo}
                onSelect={openInPaseo}
              >
                {t("agentStream.linkMenu.openInPaseo")}
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem
              testID="link-menu-open-in-browser"
              leading={leading.browser}
              onSelect={openInBrowser}
            >
              {t("agentStream.linkMenu.openInBrowser")}
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem
              testID="link-menu-copy-path"
              leading={leading.copy}
              disabled={!absolutePath}
              onSelect={copyFilePath}
            >
              {t("agentStream.linkMenu.copyFilePath")}
            </ContextMenuItem>
            <ContextMenuItem
              testID="link-menu-open-with-default-app"
              leading={leading.defaultApp}
              disabled={!fileManagerTarget || !absolutePath}
              onSelect={openWithDefaultApp}
            >
              {t("agentStream.linkMenu.openWithDefaultApp")}
            </ContextMenuItem>
            <ContextMenuItem
              testID="link-menu-reveal-in-file-manager"
              leading={leading.reveal}
              disabled={!fileManagerTarget || !absolutePath}
              onSelect={revealInFileManager}
            >
              {t("agentStream.linkMenu.revealIn", {
                target: fileManagerTarget?.label ?? t("agentStream.linkMenu.fileManagerFallback"),
              })}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// RN doesn't type "inline-flex"; RN-web honors it at runtime, which keeps the
// context-menu wrapper from breaking inline link flow (same trick as the
// file-link tooltip trigger).
const LINK_MENU_TRIGGER_STYLE: ViewStyle = {
  display: "inline-flex" as ViewStyle["display"],
};
