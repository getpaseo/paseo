import { useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAssistantFileLinkActions } from "@/assistant-file-links";
import { markdownCopyImageSourcesDataSet } from "@/assistant-selection-copy/markup";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import { htmlImageBox, type HtmlImage, type HtmlImageRow } from "./html-image-blocks";
import type { MarkdownImageSize } from "./image-decoding";
import { useMarkdownImageContext, useMarkdownImages, type MarkdownImageContext } from "./images";
import { isSvgImageSource, markdownLinkSource } from "./source";

/** Images from an HTML block, side by side at their declared size, as GitHub shows them. */
export function MarkdownHtmlImages({
  rows,
  onLinkPress,
  ...context
}: MarkdownImageContext & {
  rows: HtmlImageRow[];
  onLinkPress?: (url: string) => unknown;
}) {
  // Native renders no SVG, so those images show their alt text, as they do in Markdown.
  const sources = useMemo(
    () =>
      [...new Set(rows.flatMap((row) => row.images.map((image) => image.src)))].filter(
        (source) => isWeb || !isSvgImageSource(source),
      ),
    [rows],
  );
  const imageContext = useMarkdownImageContext(context);
  const images = useMarkdownImages(sources, imageContext);
  const actions = useAssistantFileLinkActions();
  const [lightbox, setLightbox] = useState<ImageLightboxSource | null>(null);
  const pressImage = useStableEvent((image: HtmlImage, uri: string) => {
    if (!image.href) {
      setLightbox({ type: "uri", uri });
      return;
    }
    const link = markdownLinkSource(image.href);
    if (onLinkPress && !actions.canResolveFile(link)) onLinkPress(image.href);
    else actions.open(link, "preferred");
  });
  const closeLightbox = useStableEvent(() => setLightbox(null));
  const copySources = Object.fromEntries(
    [...images.resolved].map(([source, url]) => [url, source]),
  );
  return (
    <View
      style={styles.rows}
      dataSet={isWeb ? markdownCopyImageSourcesDataSet(copySources) : undefined}
    >
      {rows.map((row) => (
        <View key={row.id} style={[styles.row, ALIGN[row.align]]}>
          {row.images.map((image) => {
            const index = sources.indexOf(image.src);
            return (
              <HtmlImageView
                key={image.id}
                image={image}
                status={index < 0 ? "unavailable" : images.statuses[index]}
                uri={images.urls[index]}
                size={images.sizes[index]}
                onPress={pressImage}
              />
            );
          })}
        </View>
      ))}
      {lightbox ? <AttachmentLightbox source={lightbox} onClose={closeLightbox} /> : null}
    </View>
  );
}

function HtmlImageView({
  image,
  status,
  uri,
  size,
  onPress,
}: {
  image: HtmlImage;
  status: "pending" | "ready" | "unavailable";
  uri: string | undefined;
  size: MarkdownImageSize | undefined;
  onPress: (image: HtmlImage, uri: string) => void;
}) {
  const { width, aspectRatio } = htmlImageBox(image, size);
  const box = useMemo(() => ({ width, aspectRatio }), [width, aspectRatio]);
  const source = useMemo(() => (uri ? { uri } : undefined), [uri]);
  const press = useStableEvent(() => {
    if (uri) onPress(image, uri);
  });
  if (status === "unavailable")
    return image.alt ? <Text style={styles.alt}>{image.alt}</Text> : null;
  if (status === "pending" || !source) return <View style={[styles.frame, styles.pending, box]} />;
  return (
    <PressHighlight
      accessibilityRole={image.href ? "link" : "button"}
      accessibilityLabel={image.alt}
      onPress={press}
      style={[styles.frame, box]}
    >
      <Image source={source} style={styles.image} resizeMode="contain" />
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  rows: { gap: theme.spacing[2] },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: theme.spacing[2] },
  alignLeft: { justifyContent: "flex-start" },
  alignCenter: { justifyContent: "center" },
  alignRight: { justifyContent: "flex-end" },
  // Narrow panes shrink an image to the row; its aspect ratio keeps the height in step.
  frame: { maxWidth: "100%", borderRadius: theme.borderRadius.lg, overflow: "hidden" },
  pending: { backgroundColor: theme.colors.surface2 },
  image: { width: "100%", height: "100%" },
  alt: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));

const ALIGN = {
  left: styles.alignLeft,
  center: styles.alignCenter,
  right: styles.alignRight,
} as const;
