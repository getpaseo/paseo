import { useFileUrl } from "@getpaseo/plugin/client";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import { useSessionStore } from "@/stores/session-store";
import { FileHtmlPreview } from "./html-preview";
import { FilePanelLoading } from "./loading";
import { FileMarkdownPreview } from "./markdown-preview";
import type { BuiltinFilePanelProps } from "./panels";
import { TextFilePanel, type TextFilePreviewProps } from "./source/panel";
import type { RenderingFilePanel, SourceFilePanel } from "./catalog";

/** Source: the text file panel with no Preview, for text files no other built-in panel claims. */
function SourcePanel(props: BuiltinFilePanelProps) {
  return <TextFilePanel {...props} />;
}

/** Markdown: the text file panel with the rendered document as its Preview. */
function MarkdownPanel(props: BuiltinFilePanelProps) {
  return <TextFilePanel {...props} preview={MarkdownPreview} />;
}

/** HTML: the text file panel with the sandboxed page as its Preview. */
function HtmlPanel(props: BuiltinFilePanelProps) {
  return <TextFilePanel {...props} preview={HtmlPreview} />;
}

/** Shows Loading until the rendered Markdown has laid out once; later edits keep the content. */
function MarkdownPreview({ text, target }: TextFilePreviewProps) {
  const client = useSessionStore((state) => state.sessions[target.serverId]?.client ?? null);
  const [rendered, setRendered] = useState(false);
  const handleLayout = useCallback(() => setRendered(true), []);
  return (
    <View style={styles.container}>
      <ScrollView style={styles.container} showsVerticalScrollIndicator>
        <View onLayout={handleLayout}>
          <FileMarkdownPreview
            source={text}
            filePath={target.path}
            workspaceRoot={target.workspaceRoot}
            client={client}
            serverId={target.serverId}
          />
        </View>
      </ScrollView>
      {rendered ? null : <FilePanelLoading />}
    </View>
  );
}

/** The page owns its scrolling, so there is no ScrollView around it. */
function HtmlPreview({ text }: TextFilePreviewProps) {
  return (
    <View style={styles.container}>
      <FileHtmlPreview html={text} testID="file-html-preview" />
    </View>
  );
}

function ImagePanel({ file }: BuiltinFilePanelProps) {
  const url = useFileUrl(file);
  if (url.status === "loading") return <FilePanelLoading />;
  if (url.status === "error") return <FilePanelError message={url.error.message} />;
  return <ZoomableImage uri={url.url} testID="image-file-preview" />;
}

function FilePanelError({ message }: { message: string }) {
  return (
    <View style={styles.centerState}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const components = {
  "builtin:markdown": MarkdownPanel,
  "builtin:html": HtmlPanel,
  "builtin:image": ImagePanel,
  "builtin:source": SourcePanel,
};

export function BuiltinFilePanelView({
  panel,
  ...props
}: BuiltinFilePanelProps & { panel: RenderingFilePanel | SourceFilePanel }) {
  const Component = components[panel.id];
  return <Component {...props} />;
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
