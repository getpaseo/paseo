import { useEffect, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { createPdfObjectUrl, revokePdfObjectUrl } from "@/pdf/pdf-object-url";
import type { PdfPreviewProps } from "@/pdf/pdf-preview-props";

/**
 * The browser renders the PDF, not us: a blob URL in an iframe hands the bytes
 * to Chromium's PDFium or Safari's PDFKit, which brings text selection, search,
 * print, and native zoom that a canvas renderer would have to reimplement.
 *
 * Electron needs `webPreferences.plugins` for this — see packages/desktop.
 */
export function PdfPreview({ bytes, testID }: PdfPreviewProps) {
  const { t } = useTranslation();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = createPdfObjectUrl(bytes);
    setObjectUrl(url);
    return () => {
      setObjectUrl(null);
      revokePdfObjectUrl(url);
    };
  }, [bytes]);

  return (
    <View style={styles.container} testID={testID}>
      {objectUrl ? (
        // Deliberately unsandboxed: a sandboxed browsing context blocks plugin
        // content, which is exactly the built-in PDF viewer this relies on. The
        // document is a blob minted from bytes we already hold, and the viewer
        // does not execute script from inside the PDF.
        // oxlint-disable-next-line react/iframe-missing-sandbox
        <iframe title={t("panels.file.pdf.title")} src={objectUrl} style={IFRAME_STYLE} />
      ) : null}
    </View>
  );
}

const IFRAME_STYLE = {
  width: "100%",
  height: "100%",
  border: "none",
  display: "block",
} as const;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
  },
}));
