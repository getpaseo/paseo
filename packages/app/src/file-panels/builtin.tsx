import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import type { Theme } from "@/styles/theme";
import { FileHtmlPreview } from "./html-preview";
import { FileMarkdownPreview } from "./markdown-preview";
import type { builtinFilePanels } from "./catalog";

interface FilePanelPreviewProps {
  content: string;
  filePath: string;
  workspaceRoot: string;
  client: DaemonClient | null;
  serverId: string;
  imagePreviewUri: string | null;
}

function MarkdownPanel(props: FilePanelPreviewProps) {
  return (
    <View style={styles.previewScrollContainer}>
      <ScrollView style={styles.previewContent} showsVerticalScrollIndicator>
        <FileMarkdownPreview
          source={props.content}
          filePath={props.filePath}
          workspaceRoot={props.workspaceRoot}
          client={props.client}
          serverId={props.serverId}
        />
      </ScrollView>
    </View>
  );
}

function HtmlPanel({ content }: FilePanelPreviewProps) {
  return (
    <View style={styles.previewScrollContainer}>
      <FileHtmlPreview html={content} testID="file-html-preview" />
    </View>
  );
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function ImagePanel({ imagePreviewUri }: FilePanelPreviewProps) {
  const { t } = useTranslation();
  if (!imagePreviewUri) {
    return (
      <View style={styles.centerState}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.loadingText}>{t("panels.file.loading")}</Text>
      </View>
    );
  }
  return <ZoomableImage uri={imagePreviewUri} testID="image-file-preview" />;
}

const components = {
  "builtin:markdown": MarkdownPanel,
  "builtin:html": HtmlPanel,
  "builtin:image": ImagePanel,
};

export function FilePanelPreview({
  panel,
  ...props
}: FilePanelPreviewProps & {
  panel: (typeof builtinFilePanels)[number];
}) {
  const Component = components[panel.id];
  return <Component {...props} />;
}

const styles = StyleSheet.create((theme) => ({
  previewScrollContainer: { flex: 1, minHeight: 0 },
  previewContent: { flex: 1, minHeight: 0 },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  loadingText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
