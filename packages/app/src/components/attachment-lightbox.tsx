import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, ChevronRight, X } from "lucide-react-native";
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

export interface ImageLightboxPaging {
  index: number;
  count: number;
  onSelect: (index: number) => void;
}

interface AttachmentLightboxProps {
  source: ImageLightboxSource | null;
  onClose: () => void;
  /** Shown under the image. */
  title?: string;
  /** Previous and next controls, with the arrow keys on the web and a "2 / 3" position. */
  paging?: ImageLightboxPaging;
}

const ModalRoot = isNative ? GestureHandlerRootView : View;
const LIGHTBOX_FIT = { padding: SPACING[4], maxWidth: 960, maxHeight: 640 };

export function AttachmentLightbox({ source, onClose, title, paging }: AttachmentLightboxProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const metadata = source?.type === "attachment" ? source.metadata : null;
  const attachmentUrl = useAttachmentPreviewUrl(metadata);
  const url = source?.type === "uri" ? source.uri : attachmentUrl;
  const contentSize = source?.type === "uri" ? source.contentSize : undefined;
  const [errored, setErrored] = useState(false);
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb && source !== null);

  useEffect(() => {
    setErrored(false);
  }, [metadata?.id, url]);

  const pager = useLightboxPaging(paging);

  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return pager.handleKeyDown(event);
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    },
    [onClose, pager],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb && source !== null,
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

  if (!source) {
    return null;
  }

  const hasError = errored || !url;

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <ModalRoot style={styles.root}>
        <WindowChromeRootRegion corners="both">
          <View ref={setWebOverlayScope} style={styles.root}>
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
              <LightboxPagingControls pager={pager} />
              <LightboxCaption title={title} paging={paging} />
            </View>
          </View>
        </WindowChromeRootRegion>
      </ModalRoot>
    </Modal>
  );
}

interface LightboxPager {
  active: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  goPrevious: () => void;
  goNext: () => void;
  /** `←` and `→` on the web; true when the key was consumed. */
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

/** Inactive without paging or with one image, so the single-image viewer stays as it was. */
function useLightboxPaging(paging: ImageLightboxPaging | undefined): LightboxPager {
  const active = paging !== undefined && paging.count > 1;
  const hasPrevious = active && paging.index > 0;
  const hasNext = active && paging.index < paging.count - 1;
  const goPrevious = useCallback(() => {
    if (paging && hasPrevious) paging.onSelect(paging.index - 1);
  }, [hasPrevious, paging]);
  const goNext = useCallback(() => {
    if (paging && hasNext) paging.onSelect(paging.index + 1);
  }, [hasNext, paging]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!active || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowLeft") goPrevious();
      else goNext();
      return true;
    },
    [active, goNext, goPrevious],
  );
  return useMemo(
    () => ({ active, hasPrevious, hasNext, goPrevious, goNext, handleKeyDown }),
    [active, goNext, goPrevious, handleKeyDown, hasNext, hasPrevious],
  );
}

function LightboxPagingControls({ pager }: { pager: LightboxPager }) {
  const { t } = useTranslation();
  if (!pager.active) return null;
  return (
    <>
      <PagingButton
        disabled={!pager.hasPrevious}
        icon={ChevronLeft}
        label={t("message.attachments.previousImage")}
        onPress={pager.goPrevious}
        side="left"
        testID="attachment-lightbox-previous"
      />
      <PagingButton
        disabled={!pager.hasNext}
        icon={ChevronRight}
        label={t("message.attachments.nextImage")}
        onPress={pager.goNext}
        side="right"
        testID="attachment-lightbox-next"
      />
    </>
  );
}

function LightboxCaption({ title, paging }: { title?: string; paging?: ImageLightboxPaging }) {
  const { t } = useTranslation();
  const position =
    paging && paging.count > 1
      ? t("message.attachments.imagePosition", { current: paging.index + 1, total: paging.count })
      : null;
  if (!title && !position) return null;
  return (
    <View pointerEvents="none" style={styles.caption} testID="attachment-lightbox-caption">
      {title ? (
        <Text numberOfLines={1} style={styles.captionTitle}>
          {title}
        </Text>
      ) : null}
      {position ? <Text style={styles.captionPosition}>{position}</Text> : null}
    </View>
  );
}

function PagingButton({
  disabled,
  icon: Icon,
  label,
  onPress,
  side,
  testID,
}: {
  disabled: boolean;
  icon: typeof ChevronLeft;
  label: string;
  onPress: () => void;
  side: "left" | "right";
  testID: string;
}) {
  const buttonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
      styles.pagingButton,
      side === "left" ? styles.pagingButtonLeft : styles.pagingButtonRight,
      hovered || pressed ? styles.pagingButtonHighlighted : null,
      disabled ? styles.pagingButtonDisabled : null,
    ],
    [disabled, side],
  );
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={buttonStyle}
      testID={testID}
    >
      <Icon size={styles.pagingIcon.width} color={styles.pagingIcon.color} />
    </Pressable>
  );
}

const PAGING_BUTTON_SIZE = 40;

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
  pagingButton: {
    position: "absolute",
    top: "50%",
    marginTop: -PAGING_BUTTON_SIZE / 2,
    width: PAGING_BUTTON_SIZE,
    height: PAGING_BUTTON_SIZE,
    borderRadius: PAGING_BUTTON_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    zIndex: 1,
  },
  pagingButtonLeft: { left: theme.spacing[2] },
  pagingButtonRight: { right: theme.spacing[2] },
  pagingButtonHighlighted: { backgroundColor: theme.colors.surface3 },
  pagingButtonDisabled: { opacity: 0.35 },
  pagingIcon: { width: theme.iconSize.md, color: theme.colors.foreground },
  caption: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    bottom: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[1],
  },
  captionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  captionPosition: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
