import { useWorkspace, useFileUrl, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { ImageDown } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import type { ZoomableViewportAction } from "@/components/zoomable-viewport/types";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { PhotoLibraryPermissionError } from "@/media/photo-library-permission";
import { saveImageToAlbum } from "@/media/save-image-to-album";
import { useSessionStore } from "@/stores/session-store";
import { FileHtmlPreview } from "./html-preview";
import { FilePanelLoading } from "./loading";
import { FileMarkdownPreview } from "./markdown-preview";
import { TextFilePanel, type TextFilePreviewProps } from "./source/panel";
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
  const handleLayout = useCallback(() => setRendered(true), []);
  return (
    <View style={styles.container}>
      <ScrollView style={styles.container} showsVerticalScrollIndicator>
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
function HtmlPreview({ text }: TextFilePreviewProps) {
  return (
    <View style={styles.container}>
      <FileHtmlPreview html={text} testID="file-html-preview" />
    </View>
  );
}

function ImagePanel({ file }: PluginFilePanelProps) {
  const url = useFileUrl(file);
  const { t } = useTranslation();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // Photos can't display vector images, so SVG files get the zoom controls without a save action.
  const canSaveToPhotos = isNative && file.extension !== "svg";

  const saveToPhotos = useCallback(async () => {
    if (url.status !== "ready" || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await saveImageToAlbum(url.url);
      toast.show(t("message.attachments.savedToPhotos"), { variant: "success" });
    } catch (error) {
      console.error("[file-panels] Failed to save image to the photo library", {
        path: file.path,
        error,
      });
      toast.error(
        error instanceof PhotoLibraryPermissionError
          ? t("message.attachments.photoPermissionDenied")
          : t("message.attachments.saveFailed"),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [file.path, t, toast, url]);

  const actions = useMemo<ZoomableViewportAction[]>(
    () =>
      canSaveToPhotos
        ? [
            {
              icon: ImageDown,
              label: t("message.attachments.saveToPhotos"),
              onPress: saveToPhotos,
              testID: "image-file-save-to-photos",
              disabled: saving,
            },
          ]
        : [],
    [canSaveToPhotos, saveToPhotos, saving, t],
  );

  if (url.status === "loading") return <FilePanelLoading />;
  if (url.status === "error") return <FilePanelError message={url.error.message} />;
  return (
    <ZoomableImage
      actions={actions}
      testID="image-file-preview"
      toolbarPlacement="top"
      uri={url.url}
    />
  );
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
