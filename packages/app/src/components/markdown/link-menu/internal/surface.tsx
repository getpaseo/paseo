import { useCallback, useMemo, type ReactElement } from "react";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import {
  ArrowRightToLine,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  type LucideIcon,
} from "lucide-react-native";
import {
  useAssistantFileLinkActions,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { openUrlInWorkspaceBrowser } from "@/desktop/browser/open-url-in-workspace";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";
import { useWorkspaceFileActions, WorkspaceFileActionItems } from "@/workspace/file-actions";
import type { OpenedLink } from "./types";

const TEST_ID = "markdown-link-menu";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedFileText = withUnistyles(FileText);
const ThemedArrowRightToLine = withUnistyles(ArrowRightToLine);
const ThemedGlobe = withUnistyles(Globe);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedCopy = withUnistyles(Copy);

export function LinkMenuSurface({ link }: { link: OpenedLink }): ReactElement {
  return link.kind === "web" ? <WebLinkMenu link={link} /> : <PathLinkMenu link={link} />;
}

function WebLinkMenu({ link }: { link: Extract<OpenedLink, { kind: "web" }> }): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { url, workspace } = link;
  const openInPaseo = useMemo(() => {
    const workspaceId = workspace?.workspaceId;
    if (!getIsElectron() || !workspace || !workspaceId) return null;
    return () => openUrlInWorkspaceBrowser({ serverId: workspace.serverId, workspaceId, url });
  }, [url, workspace]);
  const openInBrowser = useCallback(() => void openExternalUrl(url), [url]);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(url).then(
      () => toast.copied(t("workspace.linkActions.linkCopiedLabel")),
      () => toast.error(t("workspace.tabs.toasts.copyFailed")),
    );
  }, [t, toast, url]);

  return (
    <ContextMenuContent testID={TEST_ID} sheetTitle={url}>
      {openInPaseo ? (
        <LinkItem icon={ThemedGlobe} onSelect={openInPaseo} testID={`${TEST_ID}-open-in-paseo`}>
          {t("workspace.linkActions.openInPaseo")}
        </LinkItem>
      ) : null}
      <LinkItem icon={ThemedExternalLink} onSelect={openInBrowser} testID={`${TEST_ID}-open`}>
        {t("workspace.linkActions.openInDefaultBrowser")}
      </LinkItem>
      <LinkItem icon={ThemedCopy} onSelect={copy} testID={`${TEST_ID}-copy`}>
        {t("workspace.linkActions.copyLink")}
      </LinkItem>
    </ContextMenuContent>
  );
}

function PathLinkMenu({ link }: { link: Extract<OpenedLink, { kind: "path" }> }): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const links = useAssistantFileLinkActions();
  const { onOpenWorkspaceFile } = useAssistantFileLinkEnvironment();
  const fileActions = useWorkspaceFileActions(link.workspace);
  const { source, lookup, inspection } = link;
  const shown = link.found ?? inspection.written;

  const actions = fileActions.actionsFor(shown.path, shown.kind).map(({ id }) => ({
    id,
    // Chosen before the host has answered, an action waits for the real path.
    run: () =>
      void lookup.then((found) => {
        if (!found) return inspection.reportNotFound();
        return fileActions
          .actionsFor(found.path, found.kind)
          .find((action) => action.id === id)
          ?.run();
      }),
  }));

  const open = useCallback(() => links.open(source, "preferred"), [links, source]);
  const openToSide = useCallback(() => links.open(source, "side"), [links, source]);
  const canOpen = shown.kind === "file" && Boolean(onOpenWorkspaceFile);

  return (
    <ContextMenuContent testID={TEST_ID} sheetTitle={shown.path}>
      {canOpen ? (
        <>
          <LinkItem icon={ThemedFileText} onSelect={open} testID={`${TEST_ID}-open`}>
            {t("workspace.fileActions.openFile")}
          </LinkItem>
          {supportsDesktopPaneSplits() && !isCompact ? (
            <LinkItem
              icon={ThemedArrowRightToLine}
              onSelect={openToSide}
              testID={`${TEST_ID}-open-to-side`}
            >
              {t("workspace.fileActions.openToSide")}
            </LinkItem>
          ) : null}
          <ContextMenuSeparator />
        </>
      ) : null}
      <WorkspaceFileActionItems
        actions={actions}
        revealTargetName={fileActions.revealTargetName}
        testIDBase={TEST_ID}
      />
    </ContextMenuContent>
  );
}

function LinkItem({
  icon: Icon,
  onSelect,
  testID,
  children,
}: {
  icon: ReturnType<typeof withUnistyles<LucideIcon, object>>;
  onSelect: () => void;
  testID: string;
  children: string;
}): ReactElement {
  const leading = useMemo(() => <Icon size={ICON_SIZE.sm} uniProps={mutedIconMapping} />, [Icon]);
  return (
    <ContextMenuItem leading={leading} onSelect={onSelect} testID={testID}>
      {children}
    </ContextMenuItem>
  );
}
