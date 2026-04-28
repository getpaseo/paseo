import { useEffect } from "react";
import { Image, Modal, Pressable, Text, View, Linking } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { X, ExternalLink } from "lucide-react-native";
import { create } from "zustand";
import { isWeb } from "@/constants/platform";

type MediaKind = "image" | "video";

interface LightboxMedia {
  kind: MediaKind;
  url: string;
  filename: string;
  width?: number | null;
  height?: number | null;
}

interface LightboxState {
  media: LightboxMedia | null;
  open: (media: LightboxMedia) => void;
  close: () => void;
}

const useImageLightboxStore = create<LightboxState>((set) => ({
  media: null,
  open: (media) => set({ media }),
  close: () => set({ media: null }),
}));

export function openImageLightbox(media: Omit<LightboxMedia, "kind"> & { kind?: MediaKind }): void {
  useImageLightboxStore.getState().open({ kind: "image", ...media });
}

export function openVideoLightbox(media: Omit<LightboxMedia, "kind">): void {
  useImageLightboxStore.getState().open({ kind: "video", ...media });
}

/**
 * Fullscreen image/video preview, Slack-style. Mounted once at the app root;
 * chat attachments call `openImageLightbox` / `openVideoLightbox` to show
 * here. Backdrop click, close button, or Esc (web) dismisses.
 */
export function ImageLightbox() {
  const media = useImageLightboxStore((s) => s.media);
  const close = useImageLightboxStore((s) => s.close);

  useEffect(() => {
    if (!isWeb || !media) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [media, close]);

  const aspectRatio = media?.width && media?.height ? media.width / media.height : undefined;

  return (
    <Modal visible={!!media} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.contentWrap} onPress={(e) => e.stopPropagation?.()}>
          {media?.kind === "image" ? (
            <ImagePreview url={media.url} aspectRatio={aspectRatio} />
          ) : null}
          {media?.kind === "video" ? <VideoPlayer url={media.url} /> : null}
        </Pressable>
        <View style={[styles.topBar, { pointerEvents: "box-none" }]}>
          {media ? (
            <Text style={styles.filename} numberOfLines={1}>
              {media.filename}
            </Text>
          ) : null}
          <View style={styles.topBarActions}>
            <Pressable
              onPress={() => media && void Linking.openURL(media.url)}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Open original"
            >
              <ExternalLink size={18} color="#fff" />
            </Pressable>
            <Pressable
              onPress={close}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <X size={20} color="#fff" />
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

function ImagePreview({ url, aspectRatio }: { url: string; aspectRatio?: number }) {
  if (isWeb) {
    return (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <img
        src={url}
        alt=""
        style={{
          maxWidth: "90vw",
          maxHeight: "90vh",
          width: "auto",
          height: "auto",
          display: "block",
          objectFit: "contain",
          borderRadius: 6,
        }}
      />
    );
  }
  return (
    <Image
      source={{ uri: url }}
      style={[styles.media, aspectRatio ? { aspectRatio } : null]}
      resizeMode="contain"
    />
  );
}

/**
 * Web renders a native <video> element for full controls; on native we fall
 * back to opening the URL in the system player (keeps the modal dependency
 * footprint small — chat video playback is a rare path).
 */
function VideoPlayer({ url }: { url: string }) {
  if (isWeb) {
    // react-native-web passes unknown props through to the underlying DOM, so
    // we can render a plain <video>.
    return (
      // react-native-web forwards unknown JSX to the DOM; <video> renders as-is.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <video
        src={url}
        controls
        autoPlay
        style={{
          maxWidth: "100%",
          maxHeight: "90vh",
          width: "auto",
          height: "auto",
          display: "block",
          outline: "none",
          borderRadius: 6,
          backgroundColor: "#000",
        }}
      />
    );
  }
  // Native: expo-av requires a dynamic import to avoid pulling it on web.
  // For now, redirect to the system player.
  void Linking.openURL(url);
  return null;
}

const styles = StyleSheet.create(() => ({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.9)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  contentWrap: {
    maxWidth: "100%",
    maxHeight: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  media: {
    width: "100%",
    height: "100%",
    maxWidth: 1400,
    maxHeight: 900,
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  filename: {
    flex: 1,
    color: "#fff",
    fontSize: 13,
    fontWeight: "500",
  },
  topBarActions: {
    flexDirection: "row",
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
}));
