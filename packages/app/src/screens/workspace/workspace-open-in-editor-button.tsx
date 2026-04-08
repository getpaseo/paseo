import { useCallback, useEffect, useMemo } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type {
  EditorTargetDescriptorPayload,
  EditorTargetId,
} from "@server/shared/messages";
import { EditorAppIcon } from "@/components/icons/editor-app-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  resolvePreferredEditorId,
  usePreferredEditor,
} from "@/hooks/use-preferred-editor";
import { isAbsolutePath } from "@/utils/path";

interface WorkspaceOpenInEditorButtonProps {
  serverId: string;
  cwd: string;
}

export function WorkspaceOpenInEditorButton({
  serverId,
  cwd,
}: WorkspaceOpenInEditorButtonProps) {
  const { theme } = useUnistyles();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { preferredEditorId, updatePreferredEditor } = usePreferredEditor();

  const shouldLoadEditors =
    Platform.OS === "web" &&
    Boolean(client && isConnected) &&
    cwd.trim().length > 0 &&
    isAbsolutePath(cwd);

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

  const availableEditors = availableEditorsQuery.data ?? [];
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

  if (!shouldLoadEditors || !primaryOption || availableEditors.length === 0) {
    return null;
  }

  return (
    <View style={styles.row}>
      <View style={styles.splitButton}>
        <Pressable
          testID="workspace-open-in-editor-primary"
          style={({ hovered, pressed }) => [
            styles.splitButtonPrimary,
            (hovered || pressed) && styles.splitButtonPrimaryHovered,
            openMutation.isPending && styles.splitButtonPrimaryDisabled,
          ]}
          onPress={() => handleOpenEditor(primaryOption.id)}
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
              <Text style={styles.splitButtonText}>Open</Text>
            </View>
          )}
        </Pressable>
        {availableEditors.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              testID="workspace-open-in-editor-caret"
              style={({ hovered, pressed, open }) => [
                styles.splitButtonCaret,
                (hovered || pressed || open) && styles.splitButtonCaretHovered,
              ]}
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
                <DropdownMenuItem
                  key={editor.id}
                  testID={`workspace-open-in-editor-item-${editor.id}`}
                  leading={
                    <EditorAppIcon
                      editorId={editor.id}
                      size={16}
                      color={theme.colors.foregroundMuted}
                    />
                  }
                  trailing={
                    editor.id === effectivePreferredEditorId
                      ? <Check size={16} color={theme.colors.foregroundMuted} />
                      : undefined
                  }
                  onSelect={() => handleOpenEditor(editor.id)}
                >
                  {editor.label}
                </DropdownMenuItem>
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
    paddingRight: 10,
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
