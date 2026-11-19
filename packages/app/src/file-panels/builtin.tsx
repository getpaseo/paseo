import { useWorkspace, useFileUrl, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useCallback, useRef, useState } from "react";
import {
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import { useSessionStore } from "@/stores/session-store";
import { FileHtmlPreview } from "./html-preview";
import { FilePanelLoading } from "./loading";
import { FileMarkdownPreview } from "./markdown-preview";
import { TextFilePanel, type TextFilePreviewProps } from "./source/panel";
import { previewScrollKey, readPreviewScroll, writePreviewScroll } from "./preview-scroll-memory";
import type { RenderingFilePanel, SourceFilePanel } from "./catalog";

/** Source: the text file panel with no Preview, for text files no other built-in panel claims. */
function SourcePanel(props: PluginFilePanelProps) {
  return <TextFilePanel {...props} />;
}

/** Markdown: the text file panel with the rendered document as its Preview. */
function MarkdownPanel(props: PluginFilePanelProps) {
  return <TextFilePanel {...props} preview={MarkdownPreview} />;
}

/** HTML: the text file panel with the sandboxed page as its Preview. */
function HtmlPanel(props: PluginFilePanelProps) {
  return <TextFilePanel {...props} preview={HtmlPreview} />;
}

/** Shows Loading until the rendered Markdown has laid out once; later edits keep the content. */
function MarkdownPreview({ text, params, workspaceId, host }: TextFilePreviewProps) {
  const client = useSessionStore((state) => state.sessions[host.id]?.client ?? null);
  const workspaceRoot = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const [rendered, setRendered] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const scrollKey = previewScrollKey({ workspaceId, path: params.path, view: "preview" });
  const restoredRef = useRef(false);

  // The rendered document lays out once; from then on edits keep the content. The
  // first layout is also where a remembered offset is applied: before it there is no
  // scrollable height to scroll to.
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setRendered(true);
      if (restoredRef.current) return;
      const offset = readPreviewScroll(scrollKey);
      if (offset <= 0 || event.nativeEvent.layout.height < offset) return;
      restoredRef.current = true;
      scrollRef.current?.scrollTo({ y: offset, animated: false });
    },
    [scrollKey],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      writePreviewScroll(scrollKey, event.nativeEvent.contentOffset.y);
    },
    [scrollKey],
  );

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        style={styles.container}
        showsVerticalScrollIndicator
        onScroll={handleScroll}
        scrollEventThrottle={64}
      >
        <View onLayout={handleLayout}>
          <FileMarkdownPreview
            source={text}
            filePath={params.path}
            workspaceRoot={workspaceRoot ?? ""}
            client={client}
            serverId={host.id}
          />
        </View>
      </ScrollView>
      {rendered ? null : <FilePanelLoading />}
    </View>
  );
}

/** The page owns its scrolling, so there is no ScrollView around it. */
function HtmlPreview({ text, params, workspaceId }: TextFilePreviewProps) {
  return (
    <View style={styles.container}>
      <FileHtmlPreview
        html={text}
        testID="file-html-preview"
        scrollKey={previewScrollKey({ workspaceId, path: params.path, view: "preview" })}
      />
    </View>
  );
}

function ImagePanel({ file }: PluginFilePanelProps) {
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
}: PluginFilePanelProps & { panel: RenderingFilePanel | SourceFilePanel }) {
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
