import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronDown, Copy, GitBranch, Pencil } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import {
  Combobox,
  ComboboxItem,
  type ComboboxOption,
  type ComboboxProps,
} from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import {
  ToolbarLabelSelectTrigger,
  ToolbarLabelTriggerIcon,
  isToolbarLabelTriggerHighlighted,
  toolbarLabelTriggerStyle,
  toolbarLabelTriggerTextStyle,
} from "@/components/ui/toolbar-label-trigger";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { createBranchSwitcherOperations } from "@/git/branch-switcher-operations";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { useBranchSwitcher } from "@/hooks/use-branch-switcher";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCopy = withUnistyles(Copy);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const MENU_RENAME_ICON = <ThemedPencil size={16} uniProps={mutedColorMapping} />;
const MENU_SWITCH_ICON = <ThemedGitBranch size={16} uniProps={mutedColorMapping} />;
const MENU_COPY_ICON = <ThemedCopy size={16} uniProps={mutedColorMapping} />;

export interface WorkspaceHeaderBranchesProps {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null;
  currentBranchName: string;
  baseRefName: string | null;
  onCopyBranchName: () => void;
}

/**
 * `<current branch> → <base branch>` in the workspace header. The left side owns the branch the
 * checkout is on (rename, switch, copy); the right side owns what it is compared with. Both sides
 * read from the same checkout status the Changes pane and sidebar stats use, so changing either
 * here changes every comparison in the workspace.
 */
export function WorkspaceHeaderBranches({
  serverId,
  workspaceId,
  workspaceDirectory,
  currentBranchName,
  baseRefName,
  onCopyBranchName,
}: WorkspaceHeaderBranchesProps) {
  return (
    <View style={styles.row} testID="workspace-header-branches">
      <CurrentBranchControl
        serverId={serverId}
        workspaceId={workspaceId}
        workspaceDirectory={workspaceDirectory}
        currentBranchName={currentBranchName}
        onCopyBranchName={onCopyBranchName}
      />
      <ThemedArrowRight size={12} uniProps={extraMutedIconColorMapping} />
      <BaseBranchControl
        serverId={serverId}
        workspaceId={workspaceId}
        workspaceDirectory={workspaceDirectory}
        currentBranchName={currentBranchName}
        baseRefName={baseRefName}
      />
    </View>
  );
}

interface CurrentBranchControlProps {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null;
  currentBranchName: string;
  onCopyBranchName: () => void;
}

function CurrentBranchControl({
  serverId,
  workspaceId,
  workspaceDirectory,
  currentBranchName,
  onCopyBranchName,
}: CurrentBranchControlProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [isRenameOpen, setIsRenameOpen] = useState(false);

  const {
    branchOptions,
    isOpen: isSwitchOpen,
    setIsOpen: setIsSwitchOpen,
    handleBranchSelect,
  } = useBranchSwitcher({
    client,
    normalizedServerId: serverId,
    normalizedWorkspaceId: workspaceId,
    workspaceDirectory,
    currentBranchName,
    isGitCheckout: true,
    isConnected,
    toast,
    queryClient,
  });

  const openRename = useCallback(() => setIsRenameOpen(true), []);
  const closeRename = useCallback(() => setIsRenameOpen(false), []);
  const openSwitch = useCallback(() => setIsSwitchOpen(true), [setIsSwitchOpen]);

  const validateBranchName = useCallback(
    (value: string): string | null => {
      const result = validateBranchSlug(value.trim());
      return result.valid ? null : (result.error ?? t("workspace.header.branches.renameFailed"));
    },
    [t],
  );

  const handleRenameSubmit = useCallback(
    async (value: string) => {
      if (!client || !workspaceDirectory) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.renameBranch({ cwd: workspaceDirectory, branch: value.trim() });
      if (payload.error) {
        throw new Error(payload.error.message);
      }
      await invalidateCheckoutGitQueriesForClient(queryClient, {
        serverId,
        cwd: workspaceDirectory,
      });
    },
    [client, queryClient, serverId, t, workspaceDirectory],
  );

  const branchLeadingSlot = useMemo(
    () => <ThemedGitBranch size={14} uniProps={mutedColorMapping} />,
    [],
  );
  const renderBranchOption = useCallback<NonNullable<ComboboxProps["renderOption"]>>(
    ({ option, selected, active, onPress }) => (
      <ComboboxItem
        label={option.label}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={branchLeadingSlot}
      />
    ),
    [branchLeadingSlot],
  );

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor}>
      <DropdownMenu>
        <DropdownMenuTrigger
          testID="workspace-header-current-branch"
          style={toolbarLabelTriggerStyle}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.header.branches.current", {
            branchName: currentBranchName,
          })}
        >
          {(state) => {
            const highlighted = isToolbarLabelTriggerHighlighted(state);
            return (
              <>
                <Text style={toolbarLabelTriggerTextStyle(highlighted)} numberOfLines={1}>
                  {currentBranchName}
                </Text>
                <ToolbarLabelTriggerIcon>
                  <ThemedChevronDown size={12} uniProps={extraMutedIconColorMapping} />
                </ToolbarLabelTriggerIcon>
              </>
            );
          }}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          width={220}
          testID="workspace-header-current-branch-menu"
        >
          <DropdownMenuItem
            testID="workspace-header-rename-branch"
            leading={MENU_RENAME_ICON}
            disabled={!client || !workspaceDirectory}
            onSelect={openRename}
          >
            {t("workspace.header.branches.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem
            testID="workspace-header-switch-branch"
            leading={MENU_SWITCH_ICON}
            disabled={!client || !workspaceDirectory}
            onSelect={openSwitch}
          >
            {t("workspace.header.branches.switch")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            testID="workspace-header-copy-current-branch"
            leading={MENU_COPY_ICON}
            onSelect={onCopyBranchName}
          >
            {t("workspace.header.actions.copyBranchName")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Combobox
        options={branchOptions}
        value={currentBranchName}
        onSelect={handleBranchSelect}
        searchable
        placeholder={t("branchSwitcher.placeholder")}
        searchPlaceholder={t("branchSwitcher.searchPlaceholder")}
        emptyText={t("branchSwitcher.empty")}
        title={t("branchSwitcher.title")}
        open={isSwitchOpen}
        onOpenChange={setIsSwitchOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={280}
        renderOption={renderBranchOption}
      />
      <AdaptiveRenameModal
        visible={isRenameOpen}
        title={t("workspace.header.branches.renameTitle")}
        initialValue={currentBranchName}
        placeholder={currentBranchName}
        submitLabel={t("workspace.header.branches.renameSubmit")}
        onClose={closeRename}
        onSubmit={handleRenameSubmit}
        validate={validateBranchName}
        testID="workspace-header-rename-branch-modal"
      />
    </View>
  );
}

interface BaseBranchControlProps {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null;
  currentBranchName: string;
  baseRefName: string | null;
}

function BaseBranchControl({
  serverId,
  workspaceId,
  workspaceDirectory,
  currentBranchName,
  baseRefName,
}: BaseBranchControlProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const canSetBase = useHostFeature(serverId, "checkoutBaseRefSet");
  const toast = useToast();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);

  const operations = useMemo(
    () =>
      client && workspaceDirectory
        ? createBranchSwitcherOperations(client, workspaceDirectory)
        : null,
    [client, workspaceDirectory],
  );

  // Same key as useBranchSwitcher so the two pickers share one fetch per workspace.
  const suggestionsQuery = useFetchQuery({
    queryKey: ["branchSuggestions", serverId, workspaceId],
    dataShape: "list",
    staleTimeMs: 15_000,
    queryFn: async () => {
      if (!operations) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await operations.getBranchSuggestions(200);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.branches ?? [];
    },
    enabled: isOpen && Boolean(operations) && isConnected,
    retry: false,
  });

  const baseOptions = useMemo<ComboboxOption[]>(() => {
    const branches = suggestionsQuery.data ?? [];
    // The daemon refuses the current branch as its own base; hide it rather than surface the error.
    return branches
      .filter((name) => name !== currentBranchName)
      .map((name) => ({ id: name, label: name }));
  }, [currentBranchName, suggestionsQuery.data]);

  const handleOpen = useCallback(() => {
    if (!canSetBase) {
      toast.error(t("workspace.header.branches.baseUnavailable"));
      return;
    }
    setIsOpen(true);
  }, [canSetBase, t, toast]);

  const handleSelectBase = useCallback(
    (branchId: string) => {
      if (branchId === baseRefName) {
        return;
      }
      void (async () => {
        if (!client || !workspaceDirectory) {
          toast.error(t("common.errors.daemonClientUnavailable"));
          return;
        }
        try {
          const payload = await client.setCheckoutBaseRef({
            cwd: workspaceDirectory,
            baseRef: branchId,
          });
          if (payload.error) {
            toast.error(payload.error.message);
            return;
          }
          await invalidateCheckoutGitQueriesForClient(queryClient, {
            serverId,
            cwd: workspaceDirectory,
          });
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : t("workspace.header.branches.baseFailed"),
          );
        }
      })();
    },
    [baseRefName, client, queryClient, serverId, t, toast, workspaceDirectory],
  );

  const branchLeadingSlot = useMemo(
    () => <ThemedGitBranch size={14} uniProps={mutedColorMapping} />,
    [],
  );
  const renderBaseOption = useCallback<NonNullable<ComboboxProps["renderOption"]>>(
    ({ option, selected, active, onPress }) => (
      <ComboboxItem
        label={option.label}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={branchLeadingSlot}
      />
    ),
    [branchLeadingSlot],
  );

  const label = baseRefName ?? t("workspace.header.branches.setBase");

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor}>
      <ToolbarLabelSelectTrigger
        testID="workspace-header-base-branch"
        label={label}
        open={isOpen}
        onPress={handleOpen}
        disabled={!client || !workspaceDirectory}
        accessibilityRole="button"
        accessibilityLabel={
          baseRefName
            ? t("workspace.header.branches.base", { branchName: baseRefName })
            : t("workspace.header.branches.setBase")
        }
      />
      <Combobox
        options={baseOptions}
        value={baseRefName ?? ""}
        onSelect={handleSelectBase}
        searchable
        placeholder={t("workspace.header.branches.baseTitle")}
        searchPlaceholder={t("branchSwitcher.searchPlaceholder")}
        emptyText={t("branchSwitcher.empty")}
        title={t("workspace.header.branches.baseTitle")}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={280}
        renderOption={renderBaseOption}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
    minWidth: 0,
    flexShrink: 1,
  },
  anchor: {
    flexShrink: 1,
    minWidth: 0,
  },
}));
