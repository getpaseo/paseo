import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChatHistoryTranscript } from "@/attachments/chat-history/transcript";
import { workspaceAttachmentToSubmitAttachment } from "@/attachments/workspace-attachment-utils";
import {
  useDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsForScopes,
} from "@/attachments/workspace-attachments-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { resolveDraftWorkingDirectory } from "@/composer/draft/workspace-tab-core";
import type { DraftConversation } from "@/composer/draft/timeline";

export function DraftChatHistory({
  serverId,
  draft,
}: {
  serverId: string;
  draft: DraftConversation;
}) {
  const workspaceDirectory = useWorkspaceFields(
    serverId,
    draft.workspaceId,
    (workspace) => workspace.workspaceDirectory,
  );
  const workspaceScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    workspaceId: draft.workspaceId,
    cwd:
      resolveDraftWorkingDirectory({
        workspaceDirectory: workspaceDirectory || null,
        initialSetup: draft.setup ?? null,
      }) ?? "",
  });
  const draftScopeKey = useDraftWorkspaceAttachmentScopeKey(draft.draftId);
  const scopeKeys = useMemo(
    () => [draftScopeKey, workspaceScopeKey],
    [draftScopeKey, workspaceScopeKey],
  );
  const histories = useWorkspaceAttachmentsForScopes(scopeKeys).filter(
    (attachment) => attachment.kind === "chat_history",
  );
  return (
    <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
      <View style={styles.history}>
        {histories.map((history) => {
          const attachment = workspaceAttachmentToSubmitAttachment(history);
          return attachment?.type === "text" ? (
            <ChatHistoryTranscript
              key={history.id}
              attachment={attachment}
              occurrenceKey={history.id}
            />
          ) : null;
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scrollView: { flex: 1 },
  content: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  history: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    gap: theme.spacing[3],
  },
}));
