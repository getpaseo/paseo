import { useState, useCallback, useMemo, memo } from "react";
import {
  Image,
  Modal,
  Pressable,
  StyleSheet,
  View,
  type ImageLoadEventData,
  type NativeSyntheticEvent,
} from "react-native";
import type { ToolCallImage } from "@getpaseo/protocol/agent-types";

interface ToolCallImagesProps {
  images: ToolCallImage[];
}

interface InlineItem {
  id: string;
  uri: string;
  label: string;
}

interface ToolCallImageInlineProps {
  item: InlineItem;
  onPress: (uri: string) => void;
}

const FALLBACK_ASPECT_RATIO = 16 / 9;
const MAX_INLINE_HEIGHT = 480;

function makeImageSource(uri: string): { uri: string } {
  return { uri };
}

const ToolCallImageInline = memo(function ToolCallImageInline({
  item,
  onPress,
}: ToolCallImageInlineProps) {
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);

  const handlePress = useCallback(() => onPress(item.uri), [onPress, item.uri]);
  const handleLoad = useCallback((event: NativeSyntheticEvent<ImageLoadEventData>) => {
    // Native (iOS/Android) populates event.nativeEvent.source with width/height.
    // react-native-web maps onLoad to the DOM <img> load event whose
    // nativeEvent.source is undefined; fall back to the DOM target dimensions.
    const nativeSource = event?.nativeEvent?.source;
    if (
      nativeSource &&
      typeof nativeSource.width === "number" &&
      typeof nativeSource.height === "number" &&
      nativeSource.width > 0 &&
      nativeSource.height > 0
    ) {
      setAspectRatio(nativeSource.width / nativeSource.height);
      return;
    }
    const target = (
      event as unknown as { target?: { naturalWidth?: number; naturalHeight?: number } | null }
    )?.target;
    const naturalWidth = target?.naturalWidth;
    const naturalHeight = target?.naturalHeight;
    if (
      typeof naturalWidth === "number" &&
      typeof naturalHeight === "number" &&
      naturalWidth > 0 &&
      naturalHeight > 0
    ) {
      setAspectRatio(naturalWidth / naturalHeight);
    }
  }, []);
  const source = useMemo(() => makeImageSource(item.uri), [item.uri]);

  const imageStyle = useMemo(
    () => [styles.inlineImage, { aspectRatio: aspectRatio ?? FALLBACK_ASPECT_RATIO }],
    [aspectRatio],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={styles.inlineWrapper}
      accessibilityRole="imagebutton"
      accessibilityLabel={item.label}
    >
      <Image source={source} style={imageStyle} resizeMode="contain" onLoad={handleLoad} />
    </Pressable>
  );
});

export function ToolCallImages({ images }: ToolCallImagesProps) {
  const [zoomedUri, setZoomedUri] = useState<string | null>(null);

  const inlineItems = useMemo<InlineItem[]>(
    () =>
      images.map((image, index) => ({
        id: String(index),
        uri: `data:${image.mimeType};base64,${image.data}`,
        label: `Tool result image ${index + 1}`,
      })),
    [images],
  );

  const dismiss = useCallback(() => setZoomedUri(null), []);

  const zoomedSource = useMemo(() => (zoomedUri ? makeImageSource(zoomedUri) : null), [zoomedUri]);

  if (inlineItems.length === 0) {
    return null;
  }

  return (
    <View style={styles.stack}>
      {inlineItems.map((item) => (
        <ToolCallImageInline key={item.id} item={item} onPress={setZoomedUri} />
      ))}
      <Modal visible={zoomedUri !== null} transparent onRequestClose={dismiss}>
        <Pressable style={styles.zoomBackdrop} onPress={dismiss}>
          {zoomedSource ? (
            <Image source={zoomedSource} style={styles.zoomImage} resizeMode="contain" />
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    flexDirection: "column",
    gap: 8,
    marginVertical: 8,
  },
  inlineWrapper: {
    width: "100%",
    maxHeight: MAX_INLINE_HEIGHT,
    borderRadius: 6,
    overflow: "hidden",
  },
  inlineImage: {
    width: "100%",
    maxHeight: MAX_INLINE_HEIGHT,
  },
  zoomBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
  },
  zoomImage: {
    width: "100%",
    height: "100%",
  },
});
