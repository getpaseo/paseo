import { useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { EditorTargetDescriptorPayload, EditorTargetId } from "@server/shared/messages";
import { EditorAppIcon } from "@/components/icons/editor-app-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { resolvePreferredEditorId, usePreferredEditor } from "@/hooks/use-preferred-editor";
import { isAbsolutePath } from "@/utils/path";
import { isWeb } from "@/constants/platform";

interface WorkspaceOpenInEditorButtonProps {
  serverId: string;
  cwd: string;
  hideLabels?: boolean;
}

interface EditorMenuItemProps {
  editor: EditorTargetDescriptorPayload;
  isPreferred: boolean;
  onOpen: (editorId: EditorTargetId) => void;
  foregroundMuted: string;
}

function EditorMenuItem({ editor, isPreferred, onOpen, foregroundMuted }: EditorMenuItemProps) {
  const handleSelect = useCallback(() => onOpen(editor.id), [onOpen, editor.id]);
  const leading = useMemo(
    () => <EditorAppIcon editorId={editor.id} size={16} color={foregroundMuted} />,
    [editor.id, foregroundMuted],
  );
  const trailing = useMemo(
    () => (isPreferred ? <Check size={16} color={foregroundMuted} /> : undefined),
    [isPreferred, foregroundMuted],
  );
  return (
    <DropdownMenuItem
      testID={`workspace-open-in-editor-item-${editor.id}`}
      leading={leading}
      trailing={trailing}
      onSelect={handleSelect}
    >
      {editor.label}
    </DropdownMenuItem>
  );
}

export function WorkspaceOpenInEditorButton({
  serverId,
  cwd,
  hideLabels,
}: WorkspaceOpenInEditorButtonProps) {
  const { theme } = useUnistyles();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { preferredEditorId, updatePreferredEditor } = usePreferredEditor();

  const shouldLoadEditors =
    isWeb && Boolean(client && isConnected) && cwd.trim().length > 0 && isAbsolutePath(cwd);

  const availableEditorsQuery = useQuery<EditorTargetDescriptorPayload[]>({
    queryKey: ["available-editors", serverId],
    enabled: shouldLoadEditors,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      if (!client) {
        return [];
      }
      try {
        const payload = await client.listAvailableEditors();
        return payload.error ? [] : payload.editors;
      } catch {
        return [];
      }
    },
  });

  const availableEditorsRaw = availableEditorsQuery.data;
  const availableEditors = useMemo(() => availableEditorsRaw ?? [], [availableEditorsRaw]);
  const availableEditorIds = useMemo(
    () => availableEditors.map((editor: EditorTargetDescriptorPayload) => editor.id),
    [availableEditors],
  );
  const effectivePreferredEditorId = useMemo(
    () => resolvePreferredEditorId(availableEditorIds, preferredEditorId),
    [availableEditorIds, preferredEditorId],
  );
  const primaryOption =
    availableEditors.find(
      (editor: EditorTargetDescriptorPayload) => editor.id === effectivePreferredEditorId,
    ) ?? null;

  useEffect(() => {
    if (!effectivePreferredEditorId || effectivePreferredEditorId === preferredEditorId) {
      return;
    }
    void updatePreferredEditor(effectivePreferredEditorId).catch(() => undefined);
  }, [effectivePreferredEditorId, preferredEditorId, updatePreferredEditor]);

  const openMutation = useMutation({
    mutationFn: async (editorId: EditorTargetId) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.openInEditor(cwd, editorId);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return editorId;
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Failed to open in editor");
    },
  });

  const handleOpenEditor = useCallback(
    (editorId: EditorTargetId) => {
      void updatePreferredEditor(editorId).catch(() => undefined);
      openMutation.mutate(editorId);
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

  const primaryId = primaryOption?.id;
  const handlePrimaryPress = useCallback(() => {
    if (primaryId) handleOpenEditor(primaryId);
  }, [primaryId, handleOpenEditor]);

  if (!shouldLoadEditors || !primaryOption || availableEditors.length === 0) {
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
          accessibilityLabel={`Open workspace in ${primaryOption.label}`}
        >
          {openMutation.isPending ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.foreground}
              style={styles.splitButtonSpinnerOnly}
            />
          ) : (
            <View style={styles.splitButtonContent}>
              <EditorAppIcon
                editorId={primaryOption.id}
                size={16}
                color={theme.colors.foregroundMuted}
              />
              {!hideLabels && <Text style={styles.splitButtonText}>Open</Text>}
            </View>
          )}
        </Pressable>
        {availableEditors.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              testID="workspace-open-in-editor-caret"
              style={caretTriggerStyle}
              accessibilityRole="button"
              accessibilityLabel="Choose editor"
            >
              <ChevronDown size={16} color={theme.colors.foregroundMuted} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              minWidth={148}
              maxWidth={176}
              testID="workspace-open-in-editor-menu"
            >
              {availableEditors.map((editor: EditorTargetDescriptorPayload) => (
                <EditorMenuItem
                  key={editor.id}
                  editor={editor}
                  isPreferred={editor.id === effectivePreferredEditorId}
                  onOpen={handleOpenEditor}
                  foregroundMuted={theme.colors.foregroundMuted}
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
