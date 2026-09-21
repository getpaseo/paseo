import type { AgentArtifact } from "@getpaseo/protocol/agent-types";
import { Image as ExpoImage } from "expo-image";
import { FileCode2, FileDiff, FileText, Image as ImageIcon } from "lucide-react-native";
import { useCallback, useMemo, type ComponentType } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import type { AttachmentMetadata } from "@/attachments/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { formatMessageTimestamp } from "@/utils/time";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import type { Theme } from "@/styles/theme";

interface ArtifactFeedProps {
  serverId: string;
  cwd: string;
  artifacts: readonly AgentArtifact[];
  isSupported: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
  onReturnToChat?: () => void;
}

interface ArtifactCardProps {
  artifact: AgentArtifact;
  serverId: string;
  cwd: string;
  onOpen: (artifact: AgentArtifact) => void;
}

const ICON_BY_KIND: Record<
  AgentArtifact["kind"],
  ComponentType<{ size?: number; color?: string }>
> = {
  html: FileCode2,
  markdown: FileText,
  image: ImageIcon,
  svg: ImageIcon,
  pdf: FileText,
  diff: FileDiff,
};

function ArtifactKindIcon({
  kind,
  size,
  color,
}: {
  kind: AgentArtifact["kind"];
  size: number;
  color: string;
}) {
  const Icon = ICON_BY_KIND[kind];
  return <Icon size={size} color={color} />;
}

const ThemedArtifactKindIcon = withUnistyles(ArtifactKindIcon);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ArtifactFeed({
  serverId,
  cwd,
  artifacts,
  isSupported,
  onOpenWorkspaceFile,
  onReturnToChat,
}: ArtifactFeedProps) {
  const { t } = useTranslation();
  const connectionStatus = useHostRuntimeConnectionStatus(serverId);

  const handleOpen = useCallback(
    (artifact: AgentArtifact) => {
      onOpenWorkspaceFile?.({
        location: { path: artifact.path },
        disposition: "side",
      });
      onReturnToChat?.();
    },
    [onOpenWorkspaceFile, onReturnToChat],
  );

  if (connectionStatus === "connecting") {
    return (
      <View style={styles.emptyState} testID="artifact-feed-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (connectionStatus === "offline" || connectionStatus === "error") {
    return (
      <View style={styles.emptyState} testID="artifact-feed-offline">
        <ThemedArtifactKindIcon kind="html" size={22} uniProps={mutedIconMapping} />
        <Text style={styles.emptyTitle}>{t("agentPanel.states.offline") || "Offline"}</Text>
        <Text style={styles.emptyDescription}>
          {t("agentPanel.states.offlineDescription") || "Cannot connect to the host."}
        </Text>
      </View>
    );
  }

  if (!isSupported) {
    return (
      <View style={styles.emptyState} testID="artifact-feed-unsupported">
        <ThemedArtifactKindIcon kind="html" size={22} uniProps={mutedIconMapping} />
        <Text style={styles.emptyTitle}>{t("agentPanel.artifacts.updateHostTitle")}</Text>
        <Text style={styles.emptyDescription}>
          {t("agentPanel.artifacts.updateHostDescription")}
        </Text>
      </View>
    );
  }

  if (artifacts.length === 0) {
    return (
      <View style={styles.emptyState} testID="artifact-feed-empty">
        <ThemedArtifactKindIcon kind="html" size={22} uniProps={mutedIconMapping} />
        <Text style={styles.emptyTitle}>{t("agentPanel.artifacts.emptyTitle")}</Text>
        <Text style={styles.emptyDescription}>{t("agentPanel.artifacts.emptyDescription")}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.feed} testID="artifact-feed">
      {artifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.path}
          artifact={artifact}
          serverId={serverId}
          cwd={cwd}
          onOpen={handleOpen}
        />
      ))}
    </ScrollView>
  );
}

function ArtifactCard({ artifact, serverId, cwd, onOpen }: ArtifactCardProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onOpen(artifact), [artifact, onOpen]);
  const pressableStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
      styles.card,
      hovered && styles.cardHovered,
      pressed && styles.cardPressed,
    ],
    [],
  );
  const metadata = `${artifact.kind.toUpperCase()} · ${formatSize(artifact.size)} · ${formatMessageTimestamp(new Date(artifact.updatedAt))}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("agentPanel.artifacts.open", { name: artifact.name })}
      onPress={handlePress}
      style={pressableStyle}
      testID={`artifact-card-${artifact.path}`}
    >
      {artifact.kind === "image" || artifact.kind === "svg" ? (
        <ArtifactImage artifact={artifact} serverId={serverId} cwd={cwd} />
      ) : null}
      <View style={styles.cardBody}>
        <View style={styles.iconFrame}>
          <ThemedArtifactKindIcon kind={artifact.kind} size={18} uniProps={mutedIconMapping} />
        </View>
        <View style={styles.cardText}>
          <Text style={styles.name} numberOfLines={1}>
            {artifact.name}
          </Text>
          <Text style={styles.path} numberOfLines={1}>
            {artifact.path}
          </Text>
          <Text style={styles.metadata}>{metadata}</Text>
        </View>
        <Text style={styles.openLabel}>{t("agentPanel.artifacts.openLabel")}</Text>
      </View>
    </Pressable>
  );
}

function ArtifactImage({
  artifact,
  serverId,
  cwd,
}: {
  artifact: AgentArtifact;
  serverId: string;
  cwd: string;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const query = useFetchQuery<AttachmentMetadata | null>({
    queryKey: ["artifactPreview", serverId, cwd, artifact.path, artifact.updatedAt],
    enabled: Boolean(client),
    staleTimeMs: 30_000,
    dataShape: "value",
    queryFn: async () => {
      if (!client) {
        return null;
      }
      const file = await client.readFile(cwd, artifact.path);
      if (file.kind !== "image") {
        return null;
      }
      return persistAttachmentFromBytes({
        id: createPreviewAttachmentId({
          mimeType: file.mime,
          path: file.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
          contentLength: file.bytes.byteLength,
        }),
        bytes: file.bytes,
        mimeType: file.mime,
        fileName: getFileNameFromPath(file.path),
      });
    },
  });
  const previewUrl = useAttachmentPreviewUrl(query.data);
  const source = useMemo(() => ({ uri: previewUrl ?? "" }), [previewUrl]);

  if (query.isPending) {
    return (
      <View style={styles.previewState}>
        <ActivityIndicator size="small" />
      </View>
    );
  }
  if (query.isError || !previewUrl) {
    return (
      <View style={styles.previewState}>
        <ThemedArtifactKindIcon kind="image" size={24} uniProps={mutedIconMapping} />
        <Text style={styles.missingPreviewText}>
          {t("agentPanel.artifacts.previewMissing") || "Preview unavailable"}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.preview}>
      <ExpoImage source={source} contentFit="cover" style={previewImageStyle} />
    </View>
  );
}

function formatSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const previewImageStyle = {
  width: "100%",
  height: "100%",
} as const;

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  feed: {
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  card: {
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  cardHovered: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  cardPressed: {
    opacity: theme.opacity[50],
  },
  preview: {
    width: "100%",
    height: 220,
    backgroundColor: theme.colors.surface2,
  },
  previewState: {
    width: "100%",
    height: 120,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[2],
  },
  missingPreviewText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  cardBody: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  iconFrame: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
  },
  cardText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  path: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  metadata: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  openLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[2],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  emptyDescription: {
    maxWidth: 380,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
