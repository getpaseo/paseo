import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ClipboardCopy,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FilePlus,
  Files,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react-native";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { ExplorerEntry } from "@/stores/session-store";
import type { useFileExplorerCommands } from "@/file-explorer/use-file-explorer-commands";
import { getIsElectron } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

type ExplorerCommands = ReturnType<typeof useFileExplorerCommands>;

type MenuEntry =
  | { kind: "separator"; key: string }
  | {
      kind: "item";
      key: string;
      label: string;
      leading: ReactElement;
      disabled?: boolean;
      destructive?: boolean;
      onSelect: () => void;
    };

interface ExplorerItemContextMenuProps {
  entry: ExplorerEntry;
  commands: ExplorerCommands;
  children: ReactNode;
  onDownloadEntry?: (entry: ExplorerEntry) => void;
}

interface ExplorerBackgroundContextMenuProps {
  commands: ExplorerCommands;
  children: ReactNode;
}

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedFilePlus = withUnistyles(FilePlus);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedCopy = withUnistyles(Copy);
const ThemedClipboardCopy = withUnistyles(ClipboardCopy);
const ThemedFiles = withUnistyles(Files);
const ThemedEye = withUnistyles(Eye);
const ThemedDownload = withUnistyles(Download);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);

const ICON_SIZE = 14;

const icons = {
  newFile: <ThemedFilePlus size={ICON_SIZE} uniProps={mutedColorMapping} />,
  newFolder: <ThemedFolderPlus size={ICON_SIZE} uniProps={mutedColorMapping} />,
  copy: <ThemedCopy size={ICON_SIZE} uniProps={mutedColorMapping} />,
  copyContents: <ThemedClipboardCopy size={ICON_SIZE} uniProps={mutedColorMapping} />,
  duplicate: <ThemedFiles size={ICON_SIZE} uniProps={mutedColorMapping} />,
  view: <ThemedEye size={ICON_SIZE} uniProps={mutedColorMapping} />,
  download: <ThemedDownload size={ICON_SIZE} uniProps={mutedColorMapping} />,
  reveal: <ThemedExternalLink size={ICON_SIZE} uniProps={mutedColorMapping} />,
  rename: <ThemedPencil size={ICON_SIZE} uniProps={mutedColorMapping} />,
  delete: <ThemedTrash2 size={ICON_SIZE} uniProps={mutedColorMapping} />,
};

function MenuItemRow({ entry }: { entry: Extract<MenuEntry, { kind: "item" }> }) {
  return (
    <ContextMenuItem
      leading={entry.leading}
      disabled={entry.disabled}
      destructive={entry.destructive}
      onSelect={entry.onSelect}
    >
      {entry.label}
    </ContextMenuItem>
  );
}

function buildItemMenuEntries(input: {
  entry: ExplorerEntry;
  commands: ExplorerCommands;
  onDownloadEntry?: (entry: ExplorerEntry) => void;
  labels: {
    newFile: string;
    newFolder: string;
    copy: string;
    copyContents: string;
    copyPath: string;
    copyRelativePath: string;
    duplicate: string;
    viewFile: string;
    download: string;
    rename: string;
    delete: string;
  };
}): MenuEntry[] {
  const { entry, commands, onDownloadEntry, labels } = input;
  const parentPath = commands.createParentForTarget(entry);
  const disabled = Boolean(commands.pendingAction);
  const isFile = entry.kind === "file";
  const entries: MenuEntry[] = [];

  if (commands.canMutate) {
    entries.push(
      {
        kind: "item",
        key: "new-file",
        label: labels.newFile,
        leading: icons.newFile,
        disabled,
        onSelect: () => commands.openNewFilePrompt(parentPath),
      },
      {
        kind: "item",
        key: "new-folder",
        label: labels.newFolder,
        leading: icons.newFolder,
        disabled,
        onSelect: () => commands.openNewFolderPrompt(parentPath),
      },
      { kind: "separator", key: "sep-create" },
    );
  }

  if (commands.canUseLocalShell) {
    entries.push({
      kind: "item",
      key: "copy",
      label: labels.copy,
      leading: icons.copy,
      disabled,
      onSelect: () => {
        void commands.copyAsFilesystemItem(entry.path);
      },
    });
  }

  if (isFile) {
    entries.push({
      kind: "item",
      key: "copy-contents",
      label: labels.copyContents,
      leading: icons.copyContents,
      disabled,
      onSelect: () => {
        void commands.copyContents(entry);
      },
    });
  }

  entries.push(
    {
      kind: "item",
      key: "copy-path",
      label: labels.copyPath,
      leading: icons.copy,
      disabled,
      onSelect: () => {
        void commands.copyAbsolutePath(entry.path);
      },
    },
    {
      kind: "item",
      key: "copy-relative-path",
      label: labels.copyRelativePath,
      leading: icons.copy,
      disabled,
      onSelect: () => {
        void commands.copyRelativePath(entry.path);
      },
    },
  );

  if (commands.canMutate) {
    entries.push({
      kind: "item",
      key: "duplicate",
      label: labels.duplicate,
      leading: icons.duplicate,
      disabled,
      onSelect: () => {
        void commands.duplicate(entry);
      },
    });
  }

  if (isFile) {
    entries.push({
      kind: "item",
      key: "view",
      label: labels.viewFile,
      leading: icons.view,
      disabled,
      onSelect: () => commands.viewFile(entry),
    });
  }

  if (isFile && onDownloadEntry) {
    entries.push({
      kind: "item",
      key: "download",
      label: labels.download,
      leading: icons.download,
      disabled,
      onSelect: () => onDownloadEntry(entry),
    });
  }

  if (commands.canUseLocalShell) {
    entries.push({
      kind: "item",
      key: "reveal",
      label: commands.revealLabel,
      leading: icons.reveal,
      disabled,
      onSelect: () => {
        void commands.reveal(entry.path);
      },
    });
  }

  if (commands.canMutate) {
    entries.push(
      { kind: "separator", key: "sep-mutate" },
      {
        kind: "item",
        key: "rename",
        label: labels.rename,
        leading: icons.rename,
        disabled,
        onSelect: () => commands.openRenamePrompt(entry),
      },
      {
        kind: "item",
        key: "delete",
        label: labels.delete,
        leading: icons.delete,
        disabled,
        destructive: true,
        onSelect: () => {
          void commands.deleteEntry(entry);
        },
      },
    );
  }

  return entries;
}

export function ExplorerItemContextMenu({
  entry,
  commands,
  children,
  onDownloadEntry,
}: ExplorerItemContextMenuProps): ReactElement {
  const { t } = useTranslation();
  const isDesktop = getIsElectron();

  const labels = useMemo(
    () => ({
      newFile: t("workspace.fileExplorer.context.newFile"),
      newFolder: t("workspace.fileExplorer.context.newFolder"),
      copy: t("workspace.fileExplorer.context.copy"),
      copyContents: t("workspace.fileExplorer.context.copyContents"),
      copyPath: t("workspace.fileExplorer.context.copyPath"),
      copyRelativePath: t("workspace.fileExplorer.context.copyRelativePath"),
      duplicate: t("workspace.fileExplorer.context.duplicate"),
      viewFile: t("workspace.fileExplorer.context.viewFile"),
      download: t("workspace.fileExplorer.context.download"),
      rename: t("workspace.fileExplorer.context.rename"),
      delete: t("workspace.fileExplorer.context.delete"),
    }),
    [t],
  );

  const menuEntries = useMemo(
    () => buildItemMenuEntries({ entry, commands, onDownloadEntry, labels }),
    [commands, entry, labels, onDownloadEntry],
  );

  if (!isDesktop) {
    return children as ReactElement;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger enabledOnMobile={false} style={styles.triggerFill}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent align="start" width={240}>
        {menuEntries.map((menuEntry) =>
          menuEntry.kind === "separator" ? (
            <ContextMenuSeparator key={menuEntry.key} />
          ) : (
            <MenuItemRow key={menuEntry.key} entry={menuEntry} />
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ExplorerBackgroundContextMenu({
  commands,
  children,
}: ExplorerBackgroundContextMenuProps): ReactElement {
  const { t } = useTranslation();
  const isDesktop = getIsElectron();
  const disabled = Boolean(commands.pendingAction);

  const openNewFile = useCallback(() => {
    commands.openNewFilePrompt(".");
  }, [commands]);
  const openNewFolder = useCallback(() => {
    commands.openNewFolderPrompt(".");
  }, [commands]);
  const revealRoot = useCallback(() => {
    void commands.reveal(".");
  }, [commands]);

  const menuEntries = useMemo((): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    if (commands.canMutate) {
      entries.push(
        {
          kind: "item",
          key: "new-file",
          label: t("workspace.fileExplorer.context.newFile"),
          leading: icons.newFile,
          disabled,
          onSelect: openNewFile,
        },
        {
          kind: "item",
          key: "new-folder",
          label: t("workspace.fileExplorer.context.newFolder"),
          leading: icons.newFolder,
          disabled,
          onSelect: openNewFolder,
        },
      );
    }
    if (commands.canUseLocalShell) {
      if (commands.canMutate) {
        entries.push({ kind: "separator", key: "sep" });
      }
      entries.push({
        kind: "item",
        key: "reveal",
        label: commands.revealLabel,
        leading: icons.reveal,
        disabled,
        onSelect: revealRoot,
      });
    }
    return entries;
  }, [
    commands.canMutate,
    commands.canUseLocalShell,
    commands.revealLabel,
    disabled,
    openNewFile,
    openNewFolder,
    revealRoot,
    t,
  ]);

  if (!isDesktop) {
    return children as ReactElement;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger enabledOnMobile={false} style={styles.triggerFill}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent align="start" width={240}>
        {menuEntries.length === 0 ? (
          <View style={styles.emptyHint}>
            <Text style={styles.emptyHintText}>
              {t("workspace.fileExplorer.toasts.updateHostToMutate")}
            </Text>
          </View>
        ) : (
          menuEntries.map((menuEntry) =>
            menuEntry.kind === "separator" ? (
              <ContextMenuSeparator key={menuEntry.key} />
            ) : (
              <MenuItemRow key={menuEntry.key} entry={menuEntry} />
            ),
          )
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  triggerFill: {
    flex: 1,
  },
  emptyHint: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  emptyHintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
