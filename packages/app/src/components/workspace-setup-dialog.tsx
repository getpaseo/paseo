import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { createNameId } from "mnemonic-id";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Composer } from "@/components/composer";
import { useToast } from "@/contexts/toast-context";
import { useAgentInputDraft } from "@/hooks/use-agent-input-draft";
import { useProjectIconQuery } from "@/hooks/use-project-icon-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { encodeImages } from "@/utils/encode-images";
import { toErrorMessage } from "@/utils/error-messages";
import { splitComposerAttachmentsForSubmit } from "@/components/composer-attachments";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { requireWorkspaceExecutionAuthority } from "@/utils/workspace-execution";
import { navigateToPreparedWorkspaceTab } from "@/utils/workspace-navigation";
import type { ImageAttachment, MessagePayload } from "./message-input";

function toProjectIconDataUri(icon: { mimeType: string; data: string } | null): string | null {
  if (!icon) {
    return null;
  }
  return `data:${icon.mimeType};base64,${icon.data}`;
}

export function WorkspaceSetupDialog() {
  const { theme } = useUnistyles();
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
    initialCwd: sourceDirectory,
    composer: {
      initialServerId: serverId || null,
      initialValues: workspace?.workspaceDirectory
        ? { workingDir: workspace.workspaceDirectory }
        : undefined,
      isVisible: pendingWorkspaceSetup !== null,
      onlineServerIds: isConnected && serverId ? [serverId] : [],
      lockedWorkingDir: workspace?.workspaceDirectory || sourceDirectory || undefined,
    },
  });
  const composerState = chatDraft.composerState;
  if (!composerState && pendingWorkspaceSetup) {
    throw new Error("Workspace setup composer state is required");
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
      navigateToPreparedWorkspaceTab({
        serverId: pendingWorkspaceSetup.serverId,
        workspaceId,
        target,
        navigationMethod: pendingWorkspaceSetup.navigationMethod,
      });
    },
    [clearWorkspaceSetup, pendingWorkspaceSetup],
  );

  const withConnectedClient = useCallback(() => {
    if (!client || !isConnected) {
      throw new Error("Host is not connected");
    }
    return client;
  }, [client, isConnected]);

  const ensureWorkspace = useCallback(
    async (input: { cwd: string; attachments: MessagePayload["attachments"] }) => {
      if (!pendingWorkspaceSetup) {
        throw new Error("No workspace setup is pending");
      }

      if (createdWorkspace) {
        return createdWorkspace;
      }

      const connectedClient = withConnectedClient();
      const wirePayload = splitComposerAttachmentsForSubmit(input.attachments);
      const payload =
        pendingWorkspaceSetup.creationMethod === "create_worktree"
          ? await connectedClient.createPaseoWorktree({
              cwd: input.cwd,
              worktreeSlug: createNameId(),
              ...(wirePayload.attachments.length > 0
                ? { attachments: wirePayload.attachments }
                : {}),
            })
          : await connectedClient.openProject(input.cwd);

      if (payload.error || !payload.workspace) {
        throw new Error(
          payload.error ??
            (pendingWorkspaceSetup.creationMethod === "create_worktree"
              ? "Failed to create worktree"
              : "Failed to open project"),
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
        const workspace = await ensureWorkspace({ cwd, attachments });
        const connectedClient = withConnectedClient();
        if (!composerState) {
          throw new Error("Workspace setup composer state is required");
        }
        if (!composerState.selectedProvider) {
          throw new Error("Select a model");
        }

        const wirePayload = splitComposerAttachmentsForSubmit(attachments);
        const encodedImages = await encodeImages(wirePayload.images);
        const workspaceDirectory = requireWorkspaceExecutionAuthority({
          workspace,
        }).workspaceDirectory;
        const agent = await connectedClient.createAgent({
          provider: composerState.selectedProvider,
          cwd: workspaceDirectory,
          workspaceId: workspace.id,
          ...(composerState.modeOptions.length > 0 && composerState.selectedMode !== ""
            ? { modeId: composerState.selectedMode }
            : {}),
          ...(composerState.effectiveModelId ? { model: composerState.effectiveModelId } : {}),
          ...(composerState.effectiveThinkingOptionId
            ? { thinkingOptionId: composerState.effectiveThinkingOptionId }
            : {}),
          ...(text.trim() ? { initialPrompt: text.trim() } : {}),
          ...(encodedImages && encodedImages.length > 0 ? { images: encodedImages } : {}),
          ...(wirePayload.attachments.length > 0 ? { attachments: wirePayload.attachments } : {}),
        });

        if (!getIsStillActive()) {
          return;
        }

        setAgents(serverId, (previous) => {
          const next = new Map(previous);
          next.set(agent.id, normalizeAgentSnapshot(agent, serverId));
          return next;
        });
        navigateAfterCreation(workspace.id, { kind: "agent", agentId: agent.id });
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
      toast,
      withConnectedClient,
    ],
  );

  const workspaceTitle =
    workspace?.name ||
    workspace?.projectDisplayName ||
    displayName ||
    sourceDirectory.split(/[\\/]/).filter(Boolean).pop() ||
    sourceDirectory;

  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(workspaceTitle);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase();

  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);
  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files);
  }, []);
  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
  }, []);

  const composerInputWrapperStyle = useMemo(
    () => ({ backgroundColor: theme.colors.surface2 }),
    [theme.colors.surface2],
  );

  if (!pendingWorkspaceSetup || !sourceDirectory) {
    return null;
  }

  const subtitleContent = (
    <View style={styles.subtitleRow}>
      {iconDataUri ? (
        <Image source={{ uri: iconDataUri }} style={styles.projectIcon} />
      ) : (
        <View style={styles.projectIconFallback}>
          <Text style={styles.projectIconFallbackText}>{placeholderInitial}</Text>
        </View>
      )}
      <Text style={styles.projectTitle} numberOfLines={1}>
        {workspaceTitle}
      </Text>
    </View>
  );

  return (
    <AdaptiveModalSheet
      title="Create workspace"
      subtitle={subtitleContent}
      visible={true}
      onClose={handleClose}
      snapPoints={["82%", "94%"]}
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
          cwd={chatDraft.cwd}
          clearDraft={chatDraft.clear}
          autoFocus
          commandDraftConfig={composerState?.commandDraftConfig}
          statusControls={
            composerState
              ? {
                  ...composerState.statusControls,
                  disabled: pendingAction !== null,
                }
              : undefined
          }
          inputWrapperStyle={composerInputWrapperStyle}
          onAddImages={handleAddImagesCallback}
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
}));
