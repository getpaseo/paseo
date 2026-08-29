import { Maximize2, ZoomIn, ZoomOut } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { MAX_IMAGE_ZOOM, MIN_IMAGE_ZOOM } from "./transform";

interface ImageFilePreviewControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

export function ImageFilePreviewControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
}: ImageFilePreviewControlsProps) {
  const { t } = useTranslation();

  return (
    <View style={styles.root} testID="image-file-preview-controls">
      <Button
        accessibilityLabel={t("panels.file.zoomOut")}
        disabled={zoom <= MIN_IMAGE_ZOOM}
        leftIcon={ZoomOut}
        onPress={onZoomOut}
        size="xs"
        style={styles.button}
        testID="image-file-preview-zoom-out"
        variant="secondary"
      />
      <Button
        accessibilityLabel={t("panels.file.fitToView")}
        disabled={zoom <= MIN_IMAGE_ZOOM}
        leftIcon={Maximize2}
        onPress={onReset}
        size="xs"
        style={styles.button}
        testID="image-file-preview-reset"
        variant="secondary"
      />
      <Button
        accessibilityLabel={t("panels.file.zoomIn")}
        disabled={zoom >= MAX_IMAGE_ZOOM}
        leftIcon={ZoomIn}
        onPress={onZoomIn}
        size="xs"
        style={styles.button}
        testID="image-file-preview-zoom-in"
        variant="secondary"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    position: "absolute",
    top: theme.spacing[3],
    right: theme.spacing[3],
    zIndex: 1,
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  button: {
    width: 32,
    height: 32,
    paddingHorizontal: 0,
  },
}));
