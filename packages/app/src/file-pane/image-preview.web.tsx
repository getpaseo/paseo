import type { AttachmentMetadata } from "@/attachments/types";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface FileImagePreviewProps {
  uri: string;
  fileName: string;
  attachment: AttachmentMetadata | null;
}

export function FileImagePreview({ uri, fileName }: FileImagePreviewProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.container}>
      <ZoomableImage
        accessibilityLabel={t("panels.file.image.accessibilityLabel", { fileName })}
        style={styles.viewport}
        testID="workspace-file-image"
        uri={uri}
        wheelActivation="always"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    padding: theme.spacing[4],
  },
  viewport: {
    flex: 1,
    minHeight: 0,
    width: "100%",
  },
}));
