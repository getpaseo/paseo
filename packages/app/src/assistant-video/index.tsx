import React, { useCallback, useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { VIDEO_PREVIEW_MAX_BYTES } from "@/attachments/preview-limits";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import { resolveVideoMimeType } from "@/attachments/file-types";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import { VideoPreview } from "@/components/video-preview";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";

export interface AssistantVideoProps {
  source: string;
  client?: Pick<DaemonClient, "readFile"> | null;
  workspaceRoot?: string;
  serverId?: string;
}

export function AssistantVideo({ source, client, workspaceRoot, serverId }: AssistantVideoProps) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const resolution = useMemo(
    () => resolveAssistantImageSource({ source, workspaceRoot }),
    [source, workspaceRoot],
  );
  const unavailableMessage = t("panels.file.failedToLoadPreview");
  const query = useFetchQuery({
    queryKey: ["assistantVideo", serverId, workspaceRoot, source],
    enabled: active && resolution?.kind === "file_rpc" && Boolean(client),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      if (resolution?.kind !== "file_rpc" || !client) throw new Error(unavailableMessage);
      const file = await client.readFile(
        resolution.cwd,
        resolution.path,
        undefined,
        VIDEO_PREVIEW_MAX_BYTES,
      );
      const mimeType = resolveVideoMimeType({ mimeType: file.mime, path: resolution.path });
      if (!mimeType) throw new Error(unavailableMessage);
      return persistAttachmentFromBytes({
        id: createPreviewAttachmentId({
          mimeType,
          path: resolution.path,
          contentKey: `${serverId}:${resolution.cwd}`,
          size: file.size,
          modifiedAt: file.modifiedAt,
          contentLength: file.bytes.byteLength,
        }),
        bytes: file.bytes,
        mimeType,
        fileName: getFileNameFromPath(resolution.path),
      });
    },
  });
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const unavailable = !resolution || (resolution.kind === "file_rpc" && !client);

  if (query.isError || unavailable) {
    return (
      <View style={styles.error} testID="assistant-video-error">
        <Text style={styles.errorText}>{query.error?.message ?? unavailableMessage}</Text>
        {unavailable ? null : (
          <Button variant="outline" size="sm" onPress={retry}>
            {t("common.actions.retry")}
          </Button>
        )}
      </View>
    );
  }

  return (
    <View style={styles.frame} testID="assistant-video">
      {resolution.kind === "direct" ? (
        <VideoPreview key={resolution.uri} uri={resolution.uri} />
      ) : (
        <CachedVideo key={query.data?.id ?? source} attachment={query.data ?? null} />
      )}
    </View>
  );
}

function CachedVideo({ attachment }: { attachment: AttachmentMetadata | null }) {
  const uri = useAttachmentPreviewUrl(attachment);
  useEffect(() => {
    if (attachment) return retainAttachmentForGarbageCollection(attachment.id);
  }, [attachment]);
  return <VideoPreview key={uri} uri={uri} />;
}

const styles = StyleSheet.create((theme) => ({
  frame: { width: "100%", height: 320, marginVertical: theme.spacing[2] },
  error: { padding: theme.spacing[3], gap: theme.spacing[2], alignItems: "flex-start" },
  errorText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
