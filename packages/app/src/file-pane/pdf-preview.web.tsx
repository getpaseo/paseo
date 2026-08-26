import { useTranslation } from "react-i18next";

const iframeStyle = {
  flex: 1,
  minHeight: 0,
  border: "none",
  backgroundColor: "white",
} as const;

export function FilePdfPreview({ uri, testID }: { uri: string; testID?: string }) {
  const { t } = useTranslation();

  return (
    // oxlint-disable-next-line react/iframe-missing-sandbox -- Chromium's built-in PDF viewer requires an unsandboxed plugin frame.
    <iframe
      data-testid={testID}
      title={t("panels.file.editor.preview")}
      src={uri}
      referrerPolicy="no-referrer"
      style={iframeStyle}
    />
  );
}
