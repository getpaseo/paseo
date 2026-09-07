import type { AttachmentMetadata } from "@/attachments/types";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import { useTranslation } from "react-i18next";

export interface FileImagePreviewProps {
  uri: string;
  fileName: string;
  attachment: AttachmentMetadata | null;
}

export function FileImagePreview({ uri, fileName }: FileImagePreviewProps) {
  const { t } = useTranslation();
  return (
    <ZoomableImage
      accessibilityLabel={t("panels.file.image.accessibilityLabel", { fileName })}
      testID="image-file-preview"
      uri={uri}
    />
  );
}
