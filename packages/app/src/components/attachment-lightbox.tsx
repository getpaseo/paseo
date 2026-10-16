import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { isNative, isWeb } from "@/constants/platform";
import { SPACING } from "@/styles/theme";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import type { ViewportSize } from "@/components/zoomable-viewport/geometry";
import { useGlobalWebOverlayLayer, useWebOverlayRegistration } from "@/lib/overlay-root";

export type ImageLightboxSource =
  | { type: "attachment"; metadata: AttachmentMetadata }
  | { type: "uri"; uri: string; contentSize?: ViewportSize };

interface AttachmentLightboxProps {
  source: ImageLightboxSource | null;
  sources?: ImageLightboxSource[];
  index?: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
}

const ModalRoot = isNative ? GestureHandlerRootView : View;
const LIGHTBOX_FIT = { padding: SPACING[4], maxWidth: 960, maxHeight: 640 };

export function AttachmentLightbox({
  source,
  sources,
  index = 0,
  onIndexChange,
  onClose,
}: AttachmentLightboxProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  let gallery: ImageLightboxSource[] = [];
  if (sources?.length) gallery = sources;
  else if (source) gallery = [source];
  const selectedIndex = Math.max(0, Math.min(index, gallery.length - 1));
  const activeSource = gallery[selectedIndex] ?? source;
  const metadata = activeSource?.type === "attachment" ? activeSource.metadata : null;
  const attachmentUrl = useAttachmentPreviewUrl(metadata);
  const url = activeSource?.type === "uri" ? activeSource.uri : attachmentUrl;
  const contentSize = activeSource?.type === "uri" ? activeSource.contentSize : undefined;
  const [errored, setErrored] = useState(false);
  const thumbnailScrollRef = useRef<ScrollView>(null);
  const galleryCountDataSet = useMemo(
    () => ({ galleryCount: String(gallery.length) }),
    [gallery.length],
  );
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb && activeSource !== null);

  useEffect(() => {
    setErrored(false);
  }, [metadata?.id, selectedIndex, url]);

  useEffect(() => {
    thumbnailScrollRef.current?.scrollTo({ x: Math.max(0, selectedIndex * 72), animated: true });
  }, [selectedIndex]);

  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return true;
      }
      if (gallery.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        event.stopPropagation();
        onIndexChange?.(
          Math.max(
            0,
            Math.min(gallery.length - 1, selectedIndex + (event.key === "ArrowRight" ? 1 : -1)),
          ),
        );
        return true;
      }
      return false;
    },
    [gallery.length, onClose, onIndexChange, selectedIndex],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb && activeSource !== null,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  const contentLayerStyle = useMemo(
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

  if (!activeSource) {
    return null;
  }

  const hasError = errored || !url;

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <ModalRoot style={styles.root}>
        <WindowChromeRootRegion corners="both">
          <View
            ref={setWebOverlayScope}
            style={styles.root}
            dataSet={galleryCountDataSet}
            testID="attachment-lightbox-root"
          >
            <Pressable
              testID="attachment-lightbox-backdrop"
              accessibilityRole="button"
              accessibilityLabel={t("message.attachments.dismissImage")}
              onPress={onClose}
              style={styles.backdrop}
            />
            <View pointerEvents="box-none" style={contentLayerStyle}>
              <View pointerEvents="box-none" style={styles.imageArea}>
                {hasError ? (
                  <Text style={styles.errorText}>{t("message.attachments.imageLoadFailed")}</Text>
                ) : (
                  <ZoomableImage
                    key={`${selectedIndex}:${url}`}
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
                )}
              </View>
              {gallery.length > 1 ? (
                <ScrollView
                  ref={thumbnailScrollRef}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.thumbnailList}
                  style={styles.thumbnailStrip}
                  testID="attachment-lightbox-thumbnails"
                >
                  {gallery.map((item, itemIndex) => (
                    <LightboxThumbnailButton
                      key={getGallerySourceKey(item, gallery.slice(0, itemIndex))}
                      index={itemIndex}
                      source={item}
                      active={itemIndex === selectedIndex}
                      onSelect={onIndexChange}
                      label={t("message.attachments.imageNumber", { number: itemIndex + 1 })}
                    />
                  ))}
                </ScrollView>
              ) : null}
            </View>
          </View>
        </WindowChromeRootRegion>
      </ModalRoot>
    </Modal>
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
  thumbnailStrip: {
    flexGrow: 0,
    flexShrink: 0,
    alignSelf: "center",
    maxWidth: "100%",
    marginBottom: theme.spacing[3],
  },
  thumbnailList: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  thumbnail: {
    width: 64,
    height: 64,
    padding: 2,
    borderWidth: 2,
    borderColor: "transparent",
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  thumbnailActive: {
    borderColor: theme.colors.borderAccent,
  },
  thumbnailImage: {
    width: "100%",
    height: "100%",
  },
}));

function LightboxThumbnailButton({
  index,
  source,
  active,
  onSelect,
  label,
}: {
  index: number;
  source: ImageLightboxSource;
  active: boolean;
  onSelect?: (index: number) => void;
  label: string;
}) {
  const handlePress = useCallback(() => onSelect?.(index), [index, onSelect]);
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-pressed={active}
      onPress={handlePress}
      style={[styles.thumbnail, active && styles.thumbnailActive]}
      testID={`attachment-lightbox-thumbnail-${index}`}
    >
      <LightboxThumbnail source={source} />
    </Pressable>
  );
}

function getGallerySourceKey(source: ImageLightboxSource, earlier: ImageLightboxSource[]): string {
  const identity = source.type === "attachment" ? source.metadata.id : source.uri;
  const occurrence = earlier.filter((item) => {
    const earlierIdentity = item.type === "attachment" ? item.metadata.id : item.uri;
    return item.type === source.type && earlierIdentity === identity;
  }).length;
  return `${source.type}:${identity}:${occurrence}`;
}

function LightboxThumbnail({ source }: { source: ImageLightboxSource }) {
  const metadata = source.type === "attachment" ? source.metadata : null;
  const attachmentUrl = useAttachmentPreviewUrl(metadata);
  const uri = source.type === "uri" ? source.uri : attachmentUrl;
  const imageSource = useMemo(() => (uri ? { uri } : null), [uri]);
  return imageSource ? (
    <Image source={imageSource} style={styles.thumbnailImage} resizeMode="cover" />
  ) : null;
}
