import { memo, useCallback, useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ImageOff } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { AttachmentFrame } from "@/components/attachment-pill";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { useMarkdownImageSources, type MarkdownImageContext } from "@/components/markdown/images";
import { Button } from "@/components/ui/button";
import { bySizing } from "@/components/ui/control-sizing";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getToolCallImagePreview, type ToolCallImage } from "./model";
import { resolveToolCallImage } from "./image-source";

interface ImagePreviewProps {
  image: ToolCallImage;
  position: number;
  total: number;
  context: MarkdownImageContext;
  size: "summary" | "detail";
}

const ToolCallImagePreview = memo(function ToolCallImagePreview({
  image,
  position,
  total,
  context,
  size,
}: ImagePreviewProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const attachment = resolveToolCallImage(image);
  const { images } = useMarkdownImageSources([attachment.source], context);
  const { uri, status } = images[0]!;
  const [open, setOpen] = useState(false);
  const showImage = useCallback(() => setOpen(true), []);
  const closeImage = useCallback(() => setOpen(false), []);
  const source = useMemo(() => (uri ? { uri } : undefined), [uri]);
  const lightboxSource = useMemo<ImageLightboxSource | null>(
    () => (uri ? { type: "uri", uri } : null),
    [uri],
  );
  const ready = status === "ready" && source !== undefined;
  const thumbnailStyle = size === "summary" ? styles.smallImage : styles.detailImage;
  const triggerStyle = size === "summary" ? styles.summaryTrigger : styles.detailTrigger;
  const positionLabel = `${position} / ${total}`;
  const label = `${t("composer.attachments.openImage")} (${positionLabel})`;

  return (
    <>
      <HoverCard disabled={open || isCompact}>
        <HoverCardTrigger>
          <PressHighlight
            testID="tool-image-thumbnail"
            accessibilityRole="button"
            accessibilityLabel={
              status === "unavailable" ? t("message.attachments.imageLoadFailed") : label
            }
            disabled={!ready}
            onPress={showImage}
            style={triggerStyle}
          >
            <AttachmentFrame>
              {ready ? (
                <Image source={source} resizeMode="contain" style={thumbnailStyle} />
              ) : (
                <View style={[thumbnailStyle, styles.placeholder]}>
                  {status === "pending" ? (
                    <ThemedLoadingSpinner size={12} uniProps={mutedColor} />
                  ) : (
                    <ThemedImageOff size={12} uniProps={mutedColor} />
                  )}
                </View>
              )}
            </AttachmentFrame>
          </PressHighlight>
        </HoverCardTrigger>
        <HoverCardContent
          placement="bottom"
          alignment="end"
          testID="tool-image-hover-card"
          accessibilityLabel={label}
          style={styles.card}
        >
          <View style={styles.previewArea}>
            {ready ? (
              <Image source={source} resizeMode="contain" style={styles.previewImage} />
            ) : (
              <Text style={styles.caption}>
                {status === "pending"
                  ? t("common.loading")
                  : t("message.attachments.imageLoadFailed")}
              </Text>
            )}
          </View>
          <View style={styles.footer}>
            <Text numberOfLines={1} style={styles.toolName}>
              {image.toolName}
            </Text>
            <Text style={styles.caption}>{positionLabel}</Text>
          </View>
        </HoverCardContent>
      </HoverCard>
      {open ? <AttachmentLightbox source={lightboxSource} onClose={closeImage} /> : null}
    </>
  );
});

interface ToolCallImagesProps {
  images: readonly ToolCallImage[];
  context: MarkdownImageContext;
}

export function ToolCallImageSummary({
  images,
  context,
  onShowMore,
}: ToolCallImagesProps & { onShowMore: () => void }) {
  const { t } = useTranslation();
  const { visible, hiddenCount } = getToolCallImagePreview(images);
  if (images.length === 0) return null;
  return (
    <View style={styles.summary} testID="tool-image-summary">
      {hiddenCount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={onShowMore}
          accessibilityLabel={t("message.activity.details")}
        >
          +{hiddenCount}
        </Button>
      ) : null}
      {visible.map((image, index) => (
        <ToolCallImagePreview
          key={image.id}
          image={image}
          context={context}
          position={hiddenCount + index + 1}
          total={images.length}
          size="summary"
        />
      ))}
    </View>
  );
}

export function ToolCallImageDetails({
  images,
  context,
  itemId,
}: ToolCallImagesProps & { itemId: string }) {
  return (
    <View style={styles.details} testID="tool-image-details">
      {images.map((image, index) =>
        image.itemId === itemId ? (
          <ToolCallImagePreview
            key={image.id}
            image={image}
            context={context}
            position={index + 1}
            total={images.length}
            size="detail"
          />
        ) : null,
      )}
    </View>
  );
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedImageOff = withUnistyles(ImageOff);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  summary: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    paddingRight: theme.spacing[1],
  },
  details: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  summaryTrigger: {
    width: bySizing({ pointer: 32, touch: 44 }),
    height: bySizing({ pointer: 32, touch: 44 }),
    alignItems: "center",
    justifyContent: "center",
  },
  detailTrigger: { borderRadius: theme.borderRadius.md },
  smallImage: { width: theme.spacing[6], height: theme.spacing[6] },
  detailImage: { width: theme.spacing[12], height: theme.spacing[12] },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
  },
  // A dark matte preserves the image's own colors in either app theme.
  card: { width: 336, padding: theme.spacing[2], backgroundColor: theme.colors.palette.zinc[800] },
  previewArea: { width: 320, height: 240, alignItems: "center", justifyContent: "center" },
  previewImage: { width: "100%", height: "100%" },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  caption: { color: theme.colors.palette.zinc[100], fontSize: theme.fontSize.sm },
  toolName: { color: theme.colors.palette.zinc[100], fontSize: theme.fontSize.sm, flex: 1 },
}));
