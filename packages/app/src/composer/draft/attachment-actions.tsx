import { useRef } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { UserComposerAttachment } from "@/attachments/types";
import { ComposerDraftActionPill } from "@/composer/draft/action-pill";
import { ComposerImportPill } from "@/composer/draft/import-pill";
import { COMPOSER_PILL_CLEARANCE } from "@/composer/pill-styles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { usePluginAttachmentPicker } from "@/plugins";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface DraftAttachmentActionsProps {
  serverId: string;
  client: DaemonClient | null;
  attachments: UserComposerAttachment[];
  onChangeAttachments: (attachments: UserComposerAttachment[]) => void;
  onOpenImportSheet?: () => void;
}

export function DraftAttachmentActions({
  serverId,
  client,
  attachments,
  onChangeAttachments,
  onOpenImportSheet,
}: DraftAttachmentActionsProps) {
  const connected = useHostRuntimeIsConnected(serverId);
  const anchorRef = useRef<View | null>(null);
  const pluginAttachments = usePluginAttachmentPicker({
    serverId,
    client,
    connected,
    attachments,
    onChangeAttachments,
    anchorRef,
  });

  if (!onOpenImportSheet && pluginAttachments.newAgentShortcutItems.length === 0) return null;

  return (
    <View style={styles.row}>
      <View ref={anchorRef} style={styles.content}>
        {onOpenImportSheet ? <ComposerImportPill onPress={onOpenImportSheet} /> : null}
        {pluginAttachments.newAgentShortcutItems.map((item) => (
          <ComposerDraftActionPill
            key={item.id}
            testID={`composer-draft-attachment-source-${item.id}`}
            label={item.label}
            icon={item.icon}
            onPress={item.onSelect}
            disabled={!connected || item.disabled}
          />
        ))}
      </View>
      {pluginAttachments.picker}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    paddingTop: {
      xs: COMPOSER_PILL_CLEARANCE.compact,
      md: COMPOSER_PILL_CLEARANCE.wide,
    },
    paddingBottom: {
      xs: COMPOSER_PILL_CLEARANCE.compact,
      md: COMPOSER_PILL_CLEARANCE.wide,
    },
    alignItems: "center",
  },
  content: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
