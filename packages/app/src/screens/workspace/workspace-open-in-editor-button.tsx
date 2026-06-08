import { type ReactElement, useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { EditorAppIcon } from "@/components/icons/editor-app-icons";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { resolvePreferredEditorId, usePreferredEditor } from "@/hooks/use-preferred-editor";
import { openExternalUrl } from "@/utils/open-external-url";
import { isAbsolutePath } from "@/utils/path";
import { isWeb } from "@/constants/platform";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";
import { planWorkspaceOpenTargets } from "@/workspace/open-target-planner";
import type { Theme } from "@/styles/theme";

interface WorkspaceOpenInEditorButtonProps {
  serverId: string;
  cwd: string;
  activeFile?: WorkspaceFileLocation | null;
  hideLabels?: boolean;
}

interface OpenTarget {
  id: string;
  label: string;
  icon: ReactElement;
  onOpen: () => Promise<void> | void;
}

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedEditorAppIcon = withUnistyles(EditorAppIcon);
const ThemedGitHubIcon = withUnistyles(GitHubIcon);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedCheckIcon = withUnistyles(Check);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface OpenTargetMenuItemProps {
  target: OpenTarget;
  isPreferred: boolean;
  onOpen: (target: OpenTarget) => void;
}

function OpenTargetMenuItem({ target, isPreferred, onOpen }: OpenTargetMenuItemProps) {
  const handleSelect = useCallback(() => onOpen(target), [onOpen, target]);
  const trailing = useMemo(
    () => (isPreferred ? <ThemedCheckIcon size={16} uniProps={mutedColorMapping} /> : undefined),
    [isPreferred],
  );
  return (
    <DropdownMenuItem
      testID={`workspace-open-in-editor-item-${target.id}`}
      leading={target.icon}
      trailing={trailing}
      onSelect={handleSelect}
    >
      {target.label}
    </DropdownMenuItem>
  );
}

export function WorkspaceOpenInEditorButton({
  serverId,
  cwd,
  activeFile,
  hideLabels,
}: WorkspaceOpenInEditorButtonProps) {
  const toast = useToast();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { preferredEditorId, updatePreferredEditor } = usePreferredEditor();
  const { targets: desktopOpenTargets, isAvailable: isDesktopOpenAvailable } =
    useDesktopOpenTargets({
      isLocalExecution: isLocalDaemon,
    });

  const resolvedFile = useMemo(
    () =>
      activeFile ? resolveWorkspaceFilePaths({ path: activeFile.path, workspaceRoot: cwd }) : null,
    [activeFile, cwd],
  );
  const activeFileName = useMemo(
    () => resolvedFile?.absolutePath.split("/").findLast(Boolean) ?? null,
    [resolvedFile],
  );

  const canResolveWorkspace = isWeb && cwd.trim().length > 0 && isAbsolutePath(cwd);
  const shouldQueryCheckout = canResolveWorkspace && isConnected;

  const { status: checkoutStatus } = useCheckoutStatusQuery({
    serverId,
    cwd: shouldQueryCheckout ? cwd : "",
  });

  const targets = useMemo<OpenTarget[]>(
    () =>
      planWorkspaceOpenTargets({
        workspaceDirectory: cwd,
        activeFile,
        resolvedActiveFile: resolvedFile,
        desktopTargets: desktopOpenTargets,
        canUseDesktopBridge: isDesktopOpenAvailable,
        isLocalExecution: isLocalDaemon,
        checkoutStatus,
      }).map((target) => {
        if (target.source === "github") {
          return {
            id: target.id,
            label: target.label,
            icon: <ThemedGitHubIcon size={16} uniProps={mutedColorMapping} />,
            onOpen: () => openExternalUrl(target.url),
          };
        }
        return {
          id: target.id,
          label: target.label,
          icon: <ThemedEditorAppIcon editorId={target.id} size={16} uniProps={mutedColorMapping} />,
          onOpen: () => openDesktopTarget(target.openInput),
        };
      }),
    [
      activeFile,
      checkoutStatus,
      cwd,
      desktopOpenTargets,
      isDesktopOpenAvailable,
      isLocalDaemon,
      resolvedFile,
    ],
  );

  const targetIds = useMemo(() => targets.map((target) => target.id), [targets]);
  const effectivePreferredEditorId = useMemo(
    () => resolvePreferredEditorId(targetIds, preferredEditorId),
    [targetIds, preferredEditorId],
  );
  const primaryOption = targets.find((target) => target.id === effectivePreferredEditorId) ?? null;

  const openMutation = useMutation({
    mutationFn: (target: OpenTarget) => Promise.resolve(target.onOpen()),
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Failed to open workspace");
    },
  });

  const handleOpenTarget = useCallback(
    (target: OpenTarget) => {
      void updatePreferredEditor(target.id).catch(() => undefined);
      openMutation.mutate(target);
    },
    [openMutation, updatePreferredEditor],
  );

  const primaryPressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.splitButtonPrimary,
      (Boolean(hovered) || pressed) && styles.splitButtonPrimaryHovered,
      openMutation.isPending && styles.splitButtonPrimaryDisabled,
    ],
    [openMutation.isPending],
  );

  const caretTriggerStyle = useCallback(
    ({ hovered, pressed, open }: { hovered: boolean; pressed: boolean; open: boolean }) => [
      styles.splitButtonCaret,
      (hovered || pressed || open) && styles.splitButtonCaretHovered,
    ],
    [],
  );

  const handlePrimaryPress = useCallback(() => {
    if (primaryOption) {
      handleOpenTarget(primaryOption);
    }
  }, [primaryOption, handleOpenTarget]);

  if (!canResolveWorkspace || !primaryOption || targets.length === 0) {
    return null;
  }

  return (
    <View style={styles.row}>
      <View style={styles.splitButton}>
        <Pressable
          testID="workspace-open-in-editor-primary"
          style={primaryPressableStyle}
          onPress={handlePrimaryPress}
          disabled={openMutation.isPending}
          accessibilityRole="button"
          accessibilityLabel={
            activeFileName
              ? `Open ${activeFileName} in ${primaryOption.label}`
              : `Open workspace in ${primaryOption.label}`
          }
        >
          {openMutation.isPending ? (
            <ThemedActivityIndicator
              size="small"
              uniProps={foregroundColorMapping}
              style={styles.splitButtonSpinnerOnly}
            />
          ) : (
            <View style={styles.splitButtonContent}>
              {primaryOption.icon}
              {!hideLabels && <Text style={styles.splitButtonText}>Open</Text>}
            </View>
          )}
        </Pressable>
        {targets.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              testID="workspace-open-in-editor-caret"
              style={caretTriggerStyle}
              accessibilityRole="button"
              accessibilityLabel="Choose editor"
            >
              <ThemedChevronDown size={16} uniProps={mutedColorMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              minWidth={148}
              maxWidth={176}
              testID="workspace-open-in-editor-menu"
            >
              {targets.map((target) => (
                <OpenTargetMenuItem
                  key={target.id}
                  target={target}
                  isPreferred={target.id === effectivePreferredEditorId}
                  onOpen={handleOpenTarget}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  splitButton: {
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
  },
  splitButtonPrimary: {
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    justifyContent: "center",
    position: "relative",
  },
  splitButtonPrimaryIconOnly: {
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    justifyContent: "center",
    position: "relative",
  },
  splitButtonPrimaryHovered: {
    backgroundColor: theme.colors.surface2,
  },
  splitButtonPrimaryDisabled: {
    opacity: 0.6,
  },
  splitButtonText: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  splitButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  splitButtonSpinnerOnly: {
    transform: [{ scale: 0.8 }],
  },
  splitButtonCaret: {
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.borderAccent,
  },
  splitButtonCaretHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
