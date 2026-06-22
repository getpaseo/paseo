import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { createNameId } from "mnemonic-id";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Composer } from "@/composer";
import { DraftAgentModeControl } from "@/composer/agent-controls/mode-control";
import { useToast } from "@/contexts/toast-context";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { useProjectIconQuery } from "@/hooks/use-project-icon-query";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import { encodeImages } from "@/utils/encode-images";
import { toErrorMessage } from "@/utils/error-messages";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import type {
  CreateAgentRequestOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { navigateToPreparedWorkspaceTab } from "@/utils/workspace-navigation";
import type { ImageAttachment, MessagePayload } from "@/composer/types";

function toProjectIconDataUri(icon: { mimeType: string; data: string } | null): string | null {
  if (!icon) {
    return null;
  }
  return `data:${icon.mimeType};base64,${icon.data}`;
}

const SNAP_POINTS: string[] = ["82%", "94%"];

function resolveWorkspaceTitle({
  workspace,
  displayName,
  sourceDirectory,
}: {
  workspace: { name?: string | null; projectDisplayName?: string | null } | null;
  displayName: string;
  sourceDirectory: string;
}): string {
  return (
    workspace?.name ||
    workspace?.projectDisplayName ||
    displayName ||
    sourceDirectory.split(/[\\/]/).findLast(Boolean) ||
    sourceDirectory
  );
}

function buildChatDraftComposerArgs({
  serverId,
  isConnected,
  workspaceDirectory,
  sourceDirectory,
  pendingWorkspaceSetup,
}: {
  serverId: string;
  isConnected: boolean;
  workspaceDirectory: string | undefined;
  sourceDirectory: string;
  pendingWorkspaceSetup: { creationMethod: string } | null;
}) {
  return {
    initialServerId: serverId || null,
    initialValues:
      workspaceDirectory || sourceDirectory
        ? { workingDir: workspaceDirectory || sourceDirectory }
        : undefined,
    isVisible: pendingWorkspaceSetup !== null,
    onlineServerIds: isConnected && serverId ? [serverId] : [],
    lockedWorkingDir: workspaceDirectory || sourceDirectory || undefined,
  };
}

async function callWorkspaceCreation({
  creationMethod,
  connectedClient,
  input,
}: {
  creationMethod: "create_worktree" | "open_project";
  connectedClient: DaemonClient;
  input: { cwd: string };
}) {
  if (creationMethod === "create_worktree") {
    return connectedClient.createPaseoWorktree({
      cwd: input.cwd,
      worktreeSlug: createNameId(),
    });
  }
  return connectedClient.createWorkspace({
    source: { kind: "directory", path: input.cwd },
  });
}

function failureMessageForCreationMethod(
  method: "create_worktree" | "open_project",
  t: ReturnType<typeof useTranslation>["t"],
) {
  return method === "create_worktree"
    ? t("workspaceSetup.errors.failedCreateWorktree")
    : t("workspaceSetup.errors.failedOpenProject");
}

function buildCreateAgentOptions({
  composerState,
  text,
  attachments,
  encodedImages,
  workspaceDirectory,
  workspaceId,
  provider,
}: {
  composerState: {
    modeOptions: { id: string }[];
    selectedMode: string;
    effectiveModelId: string | null;
    effectiveThinkingOptionId: string | null;
  };
  text: string;
  attachments: NonNullable<CreateAgentRequestOptions["attachments"]>;
  encodedImages: NonNullable<CreateAgentRequestOptions["images"]> | null;
  workspaceDirectory: string;
  workspaceId: string;
  provider: CreateAgentRequestOptions["provider"];
}): CreateAgentRequestOptions {
  return {
    provider,
    cwd: workspaceDirectory,
    workspaceId,
    ...(composerState.modeOptions.length > 0 && composerState.selectedMode !== ""
      ? { modeId: composerState.selectedMode }
      : {}),
    ...(composerState.effectiveModelId ? { model: composerState.effectiveModelId } : {}),
    ...(composerState.effectiveThinkingOptionId
      ? { thinkingOptionId: composerState.effectiveThinkingOptionId }
      : {}),
    ...(text.trim() ? { initialPrompt: text.trim() } : {}),
    ...(encodedImages && encodedImages.length > 0 ? { images: encodedImages } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function WorkspaceSetupDialog() {
  const { t } = useTranslation();
  const toast = useToast();
  const pendingWorkspaceSetup = useWorkspaceSetupStore((state) => state.pendingWorkspaceSetup);
  const clearWorkspaceSetup = useWorkspaceSetupStore((state) => state.clearWorkspaceSetup);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);
  const setAgents = useSessionStore((state) => state.setAgents);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<ReturnType<
    typeof normalizeWorkspaceDescriptor
  > | null>(null);
  const [pendingAction, setPendingAction] = useState<"chat" | null>(null);

  const serverId = pendingWorkspaceSetup?.serverId ?? "";
  const sourceDirectory = pendingWorkspaceSetup?.sourceDirectory ?? "";
  const displayName = pendingWorkspaceSetup?.displayName?.trim() ?? "";
  const workspace = createdWorkspace;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const chatDraft = useAgentInputDraft({
    draftKey: `workspace-setup:${serverId}:${sourceDirectory}`,
    composer: buildChatDraftComposerArgs({
      serverId,
      isConnected,
      workspaceDirectory: workspace?.workspaceDirectory,
      sourceDirectory,
      pendingWorkspaceSetup,
    }),
  });
  const composerState = chatDraft.composerState;
  if (!composerState && pendingWorkspaceSetup) {
    throw new Error(t("workspaceSetup.errors.composerStateRequired"));
  }

  const { icon: projectIcon } = useProjectIconQuery({
    serverId,
    cwd: sourceDirectory,
  });
  const iconDataUri = toProjectIconDataUri(projectIcon);

  useEffect(() => {
    setErrorMessage(null);
    setCreatedWorkspace(null);
    setPendingAction(null);
  }, [pendingWorkspaceSetup?.creationMethod, serverId, sourceDirectory]);

  const handleClose = useCallback(() => {
    clearWorkspaceSetup();
  }, [clearWorkspaceSetup]);

  const navigateAfterCreation = useCallback(
    (
      workspaceId: string,
      target: { kind: "agent"; agentId: string } | { kind: "terminal"; terminalId: string },
    ) => {
      if (!pendingWorkspaceSetup) {
        return;
      }

      clearWorkspaceSetup();
      if (target.kind === "agent") {
        navigateToAgent({
          serverId: pendingWorkspaceSetup.serverId,
          agentId: target.agentId,
        });
        return;
      }

      navigateToPreparedWorkspaceTab({
        serverId: pendingWorkspaceSetup.serverId,
        workspaceId,
        target,
      });
    },
    [clearWorkspaceSetup, pendingWorkspaceSetup],
  );

  const withConnectedClient = useCallback(() => {
    if (!client || !isConnected) {
      throw new Error(t("workspaceSetup.errors.hostDisconnected"));
    }
    return client;
  }, [client, isConnected, t]);

  const ensureWorkspace = useCallback(
    async (input: { cwd: string; attachments: MessagePayload["attachments"] }) => {
      if (!pendingWorkspaceSetup) {
        throw new Error(t("workspaceSetup.errors.pendingRequired"));
      }

      if (createdWorkspace) {
        return createdWorkspace;
      }

      const connectedClient = withConnectedClient();
      const payload = await callWorkspaceCreation({
        creationMethod: pendingWorkspaceSetup.creationMethod,
        connectedClient,
        input,
      });

      if (payload.error || !payload.workspace) {
        throw new Error(
          payload.error ?? failureMessageForCreationMethod(pendingWorkspaceSetup.creationMethod, t),
        );
      }

      const normalizedWorkspace = normalizeWorkspaceDescriptor(payload.workspace);
      mergeWorkspaces(pendingWorkspaceSetup.serverId, [normalizedWorkspace]);
      if (pendingWorkspaceSetup.creationMethod === "open_project") {
        setHasHydratedWorkspaces(pendingWorkspaceSetup.serverId, true);
      }
      setCreatedWorkspace(normalizedWorkspace);
      return normalizedWorkspace;
    },
    [
      createdWorkspace,
      mergeWorkspaces,
      pendingWorkspaceSetup,
      setHasHydratedWorkspaces,
      t,
      withConnectedClient,
    ],
  );

  const getIsStillActive = useCallback(() => {
    const current = useWorkspaceSetupStore.getState().pendingWorkspaceSetup;
    return (
      current?.serverId === pendingWorkspaceSetup?.serverId &&
      current?.sourceDirectory === pendingWorkspaceSetup?.sourceDirectory &&
      current?.creationMethod === pendingWorkspaceSetup?.creationMethod
    );
  }, [
    pendingWorkspaceSetup?.creationMethod,
    pendingWorkspaceSetup?.serverId,
    pendingWorkspaceSetup?.sourceDirectory,
  ]);

  const handleCreateChatAgent = useCallback(
    async ({ text, attachments, cwd }: MessagePayload) => {
      try {
        setPendingAction("chat");
        setErrorMessage(null);
        const ensuredWorkspace = await ensureWorkspace({ cwd, attachments });
        const connectedClient = withConnectedClient();
        if (!composerState) {
          throw new Error(t("workspaceSetup.errors.composerStateRequired"));
        }
        if (!composerState.selectedProvider) {
          throw new Error(t("workspaceSetup.errors.selectModel"));
        }

        const wirePayload = splitComposerAttachmentsForSubmit(attachments);
        const encodedImages = await encodeImages(wirePayload.images);
        const workspaceDirectory = requireWorkspaceDirectory({
          workspaceId: ensuredWorkspace.id,
          workspaceDirectory: ensuredWorkspace.workspaceDirectory,
        });
        const agent = await connectedClient.createAgent(
          buildCreateAgentOptions({
            composerState,
            text,
            attachments: wirePayload.attachments,
            encodedImages: encodedImages ?? null,
            workspaceDirectory,
            workspaceId: ensuredWorkspace.id,
            provider: composerState.selectedProvider,
          }),
        );

        if (!getIsStillActive()) {
          return;
        }

        setAgents(serverId, (previous) => {
          const next = new Map(previous);
          next.set(
            agent.id,
            applyLegacyDaemonWorkspaceOwnership({
              serverId,
              agent: normalizeAgentSnapshot(agent, serverId),
            }),
          );
          return next;
        });
        navigateAfterCreation(ensuredWorkspace.id, { kind: "agent", agentId: agent.id });
      } catch (error) {
        const message = toErrorMessage(error);
        setErrorMessage(message);
        toast.error(message);
      } finally {
        if (getIsStillActive()) {
          setPendingAction(null);
        }
      }
    },
    [
      composerState,
      getIsStillActive,
      navigateAfterCreation,
      serverId,
      setAgents,
      ensureWorkspace,
      t,
      toast,
      withConnectedClient,
    ],
  );

  const workspaceTitle = resolveWorkspaceTitle({ workspace, displayName, sourceDirectory });

  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(workspaceTitle);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase();

  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);
  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files);
  }, []);
  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
  }, []);

  const isCompact = useIsCompactFormFactor();
  const iconSource = useMemo(() => (iconDataUri ? { uri: iconDataUri } : null), [iconDataUri]);
  const agentControlsWithDisabled = useMemo(
    () =>
      composerState
        ? {
            ...composerState.agentControls,
            disabled: pendingAction !== null,
          }
        : undefined,
    [composerState, pendingAction],
  );

  const composerFooter = useMemo(
    () =>
      isCompact && agentControlsWithDisabled ? (
        <DraftAgentModeControl placement="footer" {...agentControlsWithDisabled} />
      ) : undefined,
    [isCompact, agentControlsWithDisabled],
  );

  const subtitleContent = useMemo(
    () => (
      <View style={styles.subtitleRow}>
        {iconSource ? (
          <Image source={iconSource} style={styles.projectIcon} />
        ) : (
          <View style={styles.projectIconFallback}>
            <Text style={styles.projectIconFallbackText}>{placeholderInitial}</Text>
          </View>
        )}
        <Text style={styles.projectTitle} numberOfLines={1}>
          {workspaceTitle}
        </Text>
      </View>
    ),
    [iconSource, placeholderInitial, workspaceTitle],
  );

  const sheetHeader = useMemo<SheetHeader>(
    () => ({ title: t("workspaceSetup.title"), subtitle: subtitleContent }),
    [subtitleContent, t],
  );

  if (!pendingWorkspaceSetup || !sourceDirectory) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      header={sheetHeader}
      visible={true}
      onClose={handleClose}
      snapPoints={SNAP_POINTS}
      testID="workspace-setup-dialog"
      desktopMaxWidth={640}
      onFilesDropped={handleFilesDropped}
    >
      <View style={styles.section}>
        <Composer
          agentId={`workspace-setup:${serverId}:${sourceDirectory}`}
          serverId={serverId}
          isPaneFocused={true}
          onSubmitMessage={handleCreateChatAgent}
          isSubmitLoading={pendingAction === "chat"}
          blurOnSubmit={true}
          value={chatDraft.text}
          onChangeText={chatDraft.setText}
          attachments={chatDraft.attachments}
          onChangeAttachments={chatDraft.setAttachments}
          cwd={sourceDirectory}
          clearDraft={chatDraft.clear}
          autoFocus
          commandDraftConfig={composerState?.commandDraftConfig}
          agentControls={agentControlsWithDisabled}
          inputWrapperStyle={styles.composerInputWrapper}
          onAddImages={handleAddImagesCallback}
          footer={composerFooter}
        />
      </View>

      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  projectIcon: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.borderRadius.sm,
  },
  projectIconFallback: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconFallbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: 9,
  },
  projectTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  section: {
    gap: theme.spacing[3],
    marginHorizontal: -theme.spacing[6],
    marginVertical: -theme.spacing[2],
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    lineHeight: 20,
  },
  composerInputWrapper: {
    backgroundColor: theme.colors.surface2,
  },
}));
