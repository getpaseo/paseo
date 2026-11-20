import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { Modal } from "@/components/ui/modal";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  type AttachmentPreviewUrl,
  useAttachmentPreviewUrl,
} from "@/attachments/use-attachment-preview-url";
import { isNative } from "@/constants/platform";
import { SPACING } from "@/styles/theme";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import type { ViewportSize } from "@/components/zoomable-viewport/geometry";
import { useGlobalOverlayLayer } from "@/lib/overlay-root";
import { WindowSafeArea } from "@/window-layout";

export type ImageLightboxSource =
  | { type: "attachment"; metadata: AttachmentMetadata }
  | { type: "uri"; uri: string; contentSize?: ViewportSize };

interface AttachmentLightboxProps {
  source: ImageLightboxSource | null;
  onClose: () => void;
}

const ModalRoot = isNative ? GestureHandlerRootView : View;
const LIGHTBOX_FIT = { padding: SPACING[4], maxWidth: 960, maxHeight: 640 };

export function AttachmentLightbox({ source, onClose }: AttachmentLightboxProps) {
  const { t } = useTranslation();
  const metadata = source?.type === "attachment" ? source.metadata : null;
  const attachmentPreview = useAttachmentPreviewUrl(metadata);
  const image: AttachmentPreviewUrl =
    source?.type === "uri" ? { status: "ready", url: source.uri } : attachmentPreview;
  const url = image.status === "ready" ? image.url : null;
  const contentSize = source?.type === "uri" ? source.contentSize : undefined;
  const [errored, setErrored] = useState(false);
  const failed = errored || image.status === "failed";
  const modalLayer = useGlobalOverlayLayer("modal", source !== null);

  useEffect(() => {
    setErrored(false);
  }, [metadata?.id, url]);

  const handleOverlayKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    },
    [onClose],
  );
  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape"],
    active: source !== null,
    layer: modalLayer,
    onKeyDown: handleOverlayKeyDown,
  });

  const actions = useMemo(
    () => [
      {
        icon: X,
        label: t("message.attachments.closeImage"),
        onPress: onClose,
        testID: "attachment-lightbox-close",
      },
    ],
    [onClose, t],
  );

  const handleImageError = useCallback(() => setErrored(true), []);

  if (!source) {
    return null;
  }

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <ModalRoot style={styles.root}>
        {/* The modal draws over the whole window: its insets are the window's, not the ones left
            where the image was opened (inside a sheet tab, the bottom one is already spent). */}
        <WindowSafeArea>
          <WindowChromeRootRegion corners="both">
            <View ref={setOverlayScope} style={styles.root}>
              <Pressable
                testID="attachment-lightbox-backdrop"
                accessibilityRole="button"
                accessibilityLabel={t("message.attachments.dismissImage")}
                onPress={onClose}
                style={styles.backdrop}
              />
              <LightboxImageArea>
                {failed ? (
                  <Text style={styles.errorText}>{t("message.attachments.imageLoadFailed")}</Text>
                ) : null}
                {!failed && url ? (
                  <ZoomableImage
                    accessibilityLabel={t("composer.attachments.openImage")}
                    actions={actions}
                    contentSize={contentSize}
                    fit={LIGHTBOX_FIT}
                    onError={handleImageError}
                    onPressOutsideContent={onClose}
                    style={styles.imageViewport}
                    testID="attachment-lightbox"
                    uri={url}
                  />
                ) : null}
              </LightboxImageArea>
            </View>
          </WindowChromeRootRegion>
        </WindowSafeArea>
      </ModalRoot>
    </Modal>
  );
}

function LightboxImageArea({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const style = useMemo(
    () => [
      styles.contentLayer,
      {
        paddingTop: insets.top,
        paddingRight: insets.right,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
      },
    ],
    [insets.bottom, insets.left, insets.right, insets.top],
  );
  return (
    <View pointerEvents="box-none" style={style}>
      <View pointerEvents="box-none" style={styles.imageArea}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.9)",
  },
  contentLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  imageArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  imageViewport: {
    flex: 1,
    width: "100%",
    alignSelf: "center",
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
