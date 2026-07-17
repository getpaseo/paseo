import { Maximize2, ScanEye } from "lucide-react-native";
import React from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Image as RNImage, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  formatImageDiffSize,
  imageStatusLabel,
  imageUri,
  type AvailableImage,
  type ImageSidePayload,
} from "./image-diff-view-model";
import { useImageDiffQuery, type UseImageDiffQueryOptions } from "./use-image-diff-query";

interface ImageDiffBodyProps extends UseImageDiffQueryOptions {
  onOpenFile?: (path: string) => void;
}

interface IconTheme {
  colors: {
    foregroundMuted: string;
    surface0: string;
  };
}

const DEFAULT_IMAGE_DIFF_HEIGHT = 260;
const LARGE_IMAGE_DIFF_HEIGHT = 420;
const foregroundMutedIconColorMapping = (theme: IconTheme) => ({
  color: theme.colors.foregroundMuted,
});
const surfaceIconColorMapping = (theme: IconTheme) => ({ color: theme.colors.surface0 });
const ThemedMaximize2 = withUnistyles(Maximize2);
const ThemedScanEye = withUnistyles(ScanEye);

export function ImageDiffBody(props: ImageDiffBodyProps) {
  const { path, onOpenFile } = props;
  const { t } = useTranslation();
  const query = useImageDiffQuery(props);
  const [showDiffOverlay, setShowDiffOverlay] = React.useState(false);
  const [isLargeHeight, setIsLargeHeight] = React.useState(false);
  const openCurrentFile = React.useCallback(() => {
    onOpenFile?.(path);
  }, [onOpenFile, path]);
  const toggleHeight = React.useCallback(() => {
    setIsLargeHeight((large) => !large);
  }, []);
  const toggleDiffOverlay = React.useCallback(() => {
    setShowDiffOverlay((visible) => !visible);
  }, []);

  if (query.isLoading || !query.data) {
    return (
      <View style={styles.stateRow}>
        <ActivityIndicator size="small" />
        <Text style={styles.stateText}>{t("workspace.git.imageDiff.loading")}</Text>
      </View>
    );
  }

  if (query.data.error) {
    return <StatusMessage label={query.data.error.message} />;
  }

  const canCompare =
    query.data.oldImage.status === "available" && query.data.newImage.status === "available";
  const diffOverlay =
    showDiffOverlay && query.data.diffImage.status === "available" ? query.data.diffImage : null;

  return (
    <View style={styles.root}>
      <ImageDiffToolbar
        canCompare={canCompare}
        hasDiffImage={query.data.diffImage.status === "available"}
        isLargeHeight={isLargeHeight}
        showDiffOverlay={showDiffOverlay}
        onToggleHeight={toggleHeight}
        onToggleDiffOverlay={toggleDiffOverlay}
      />
      <ImageDiffContent
        height={isLargeHeight ? LARGE_IMAGE_DIFF_HEIGHT : DEFAULT_IMAGE_DIFF_HEIGHT}
        oldImage={query.data.oldImage}
        newImage={query.data.newImage}
        diffOverlay={diffOverlay}
        onOpenCurrentFile={onOpenFile ? openCurrentFile : undefined}
      />
    </View>
  );
}

function ImageDiffToolbar({
  canCompare,
  hasDiffImage,
  isLargeHeight,
  showDiffOverlay,
  onToggleHeight,
  onToggleDiffOverlay,
}: {
  canCompare: boolean;
  hasDiffImage: boolean;
  isLargeHeight: boolean;
  showDiffOverlay: boolean;
  onToggleHeight: () => void;
  onToggleDiffOverlay: () => void;
}) {
  const { t } = useTranslation();
  const heightButtonLabel = t(
    isLargeHeight ? "workspace.git.imageDiff.heightLarge" : "workspace.git.imageDiff.heightDefault",
  );

  if (!canCompare) {
    return null;
  }

  return (
    <View style={styles.toolbar} testID="image-diff-toolbar">
      {hasDiffImage ? (
        <Pressable
          accessibilityLabel={t("workspace.git.imageDiff.xray")}
          accessibilityRole="button"
          aria-pressed={showDiffOverlay}
          onPress={onToggleDiffOverlay}
          style={showDiffOverlay ? styles.iconButtonSelected : styles.iconButton}
        >
          <ThemedScanEye
            size={14}
            uniProps={showDiffOverlay ? surfaceIconColorMapping : foregroundMutedIconColorMapping}
          />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityLabel={heightButtonLabel}
        accessibilityRole="button"
        aria-pressed={isLargeHeight}
        onPress={onToggleHeight}
        style={isLargeHeight ? styles.iconButtonSelected : styles.iconButton}
      >
        <ThemedMaximize2
          size={14}
          uniProps={isLargeHeight ? surfaceIconColorMapping : foregroundMutedIconColorMapping}
        />
      </Pressable>
    </View>
  );
}

function ImageDiffContent({
  height,
  oldImage,
  newImage,
  diffOverlay,
  onOpenCurrentFile,
}: {
  height: number;
  oldImage: ImageSidePayload;
  newImage: ImageSidePayload;
  diffOverlay: AvailableImage | null;
  onOpenCurrentFile?: () => void;
}) {
  const { t } = useTranslation();
  const addedImage = oldImage.status === "missing" && newImage.status === "available";
  if (addedImage) {
    return (
      <View style={styles.container}>
        <ImagePanel
          title={t("workspace.git.imageDiff.new")}
          image={newImage}
          emptyLabel={t("workspace.git.imageDiff.imageDeleted")}
          onOpenImage={onOpenCurrentFile}
          overlayImage={diffOverlay}
          height={height}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ImagePanel
        title={t("workspace.git.imageDiff.old")}
        image={oldImage}
        emptyLabel={t("workspace.git.imageDiff.noPreviousImage")}
        height={height}
      />
      <ImagePanel
        title={t("workspace.git.imageDiff.new")}
        image={newImage}
        emptyLabel={t("workspace.git.imageDiff.imageDeleted")}
        onOpenImage={onOpenCurrentFile}
        overlayImage={diffOverlay}
        height={height}
      />
    </View>
  );
}

function ImagePanel({
  title,
  image,
  emptyLabel,
  onOpenImage,
  overlayImage,
  height,
}: {
  title: string;
  image: ImageSidePayload;
  emptyLabel: string;
  onOpenImage?: () => void;
  overlayImage?: AvailableImage | null;
  height: number;
}) {
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>{title}</Text>
      <PanelContent
        image={image}
        emptyLabel={emptyLabel}
        title={title}
        onOpenImage={onOpenImage}
        overlayImage={overlayImage}
        height={height}
      />
    </View>
  );
}

function PanelContent({
  image,
  emptyLabel,
  title,
  onOpenImage,
  overlayImage,
  height,
}: {
  image: ImageSidePayload;
  emptyLabel: string;
  title: string;
  onOpenImage?: () => void;
  overlayImage?: AvailableImage | null;
  height: number;
}) {
  const { t } = useTranslation();
  if (image.status === "available") {
    return (
      <AvailableImageView
        image={image}
        title={title}
        onOpenImage={onOpenImage}
        overlayImage={overlayImage}
        height={height}
      />
    );
  }
  if (image.status === "missing") {
    return <StatusMessage label={emptyLabel} />;
  }
  return <StatusMessage label={imageStatusLabel(image, t)} />;
}

function AvailableImageView({
  image,
  title,
  onOpenImage,
  overlayImage,
  height,
}: {
  image: AvailableImage;
  title: string;
  onOpenImage?: () => void;
  overlayImage?: AvailableImage | null;
  height: number;
}) {
  const source = React.useMemo(() => ({ uri: imageUri(image) }), [image]);
  const surfaceStyle = React.useMemo(() => [styles.imageSurface, { height }], [height]);
  const { t } = useTranslation();
  const imageContent = (
    <View style={surfaceStyle} testID="image-diff-panel-surface">
      <RNImage
        source={source}
        style={styles.panelImage}
        resizeMode="contain"
        testID="image-diff-panel-image"
      />
      {overlayImage ? <OverlayImage image={overlayImage} /> : null}
    </View>
  );

  return (
    <View style={styles.imageFrame}>
      {onOpenImage ? (
        <Pressable
          accessibilityLabel={t("workspace.git.imageDiff.openImagePreview", { title })}
          accessibilityRole="button"
          onPress={onOpenImage}
          testID="image-diff-panel-image-button"
        >
          {imageContent}
        </Pressable>
      ) : (
        imageContent
      )}
      <Text style={styles.metaText}>
        {image.width} x {image.height} · {formatImageDiffSize(image.size)}
      </Text>
    </View>
  );
}

function OverlayImage({ image }: { image: AvailableImage }) {
  const source = React.useMemo(() => ({ uri: imageUri(image) }), [image]);
  return (
    <RNImage
      source={source}
      style={styles.overlayImage}
      resizeMode="contain"
      testID="image-diff-overlay-image"
    />
  );
}

function StatusMessage({ label }: { label: string }) {
  return (
    <View style={styles.statusContainer}>
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  container: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  iconButton: {
    alignSelf: "flex-start",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
  },
  iconButtonSelected: {
    alignSelf: "flex-start",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.foreground,
  },
  panel: {
    flexGrow: 1,
    flexBasis: 220,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  panelTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  imageFrame: {
    minHeight: 180,
    gap: theme.spacing[2],
  },
  imageSurface: {
    width: "100%",
    height: 180,
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
  },
  panelImage: {
    position: "absolute",
    width: "100%",
    height: "100%",
  },
  overlayImage: {
    position: "absolute",
    width: "100%",
    height: "100%",
    opacity: 0.65,
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusContainer: {
    minHeight: 180,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));
