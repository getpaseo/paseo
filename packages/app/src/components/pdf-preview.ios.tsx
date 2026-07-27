import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { WebView } from "react-native-webview";
import { Download } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { persistAttachmentFromBytes } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { PDF_MIME_TYPE } from "@/pdf/pdf-mime";
import { parentDirectoryUri, type PdfPreviewProps } from "@/pdf/pdf-preview-props";

/**
 * WKWebView displays PDFs itself, with PDFKit's selection and zoom gestures —
 * but only from a URL, so the bytes are staged to a file first.
 */
export function PdfPreview({ bytes, cacheId, fileName, onDownload, testID }: PdfPreviewProps) {
  const { t } = useTranslation();
  const [attachment, setAttachment] = useState<AttachmentMetadata | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setAttachment(null);
    setFailed(false);
    void (async () => {
      try {
        const staged = await persistAttachmentFromBytes({
          id: cacheId,
          bytes,
          mimeType: PDF_MIME_TYPE,
          fileName,
        });
        if (active) setAttachment(staged);
      } catch (error) {
        console.error("[pdf-preview] Failed to stage the PDF for viewing", error);
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [bytes, cacheId, fileName]);

  const fileUri = useAttachmentPreviewUrl(attachment);
  const source = useMemo(() => (fileUri ? { uri: fileUri } : null), [fileUri]);
  const handleError = useCallback(() => setFailed(true), []);

  if (failed) {
    return (
      <View style={styles.centerState} testID={testID}>
        <Text style={styles.errorText}>{t("panels.file.pdf.failed")}</Text>
        {onDownload ? (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={Download}
            onPress={onDownload}
            testID="workspace-file-pdf-download"
          >
            {t("workspace.fileActions.download")}
          </Button>
        ) : null}
      </View>
    );
  }

  if (!source) {
    return (
      <View style={styles.centerState} testID={testID}>
        <ActivityIndicator size="small" />
        <Text style={styles.loadingText}>{t("panels.file.pdf.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID={testID}>
      <WebView
        source={source}
        style={styles.webView}
        containerStyle={styles.webViewContainer}
        originWhitelist={PDF_ORIGIN_WHITELIST}
        // Without the read grant WKWebView refuses the file it was just handed.
        allowingReadAccessToURL={parentDirectoryUri(source.uri)}
        allowFileAccess
        scrollEnabled
        nestedScrollEnabled
        bounces={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        onError={handleError}
      />
    </View>
  );
}

const PDF_ORIGIN_WHITELIST = ["file://*", "about:*"];

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
  },
  webView: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
  },
  webViewContainer: {
    flex: 1,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
