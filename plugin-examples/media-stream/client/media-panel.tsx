import { useRpc, useSubscription, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { checkFrame } from "../shared/frame-check";
import {
  decodeMediaFrame,
  MediaOpcode,
  mediaStream,
  VIDEO,
  type MediaFrame,
} from "../shared/media-frames";

interface Playback {
  picture: Uint8Array | null;
  level: number;
  videoFrames: number;
  keyframes: number;
  audioChunks: number;
  bytes: number;
}

const EMPTY: Playback = {
  picture: null,
  level: 0,
  videoFrames: 0,
  keyframes: 0,
  audioChunks: 0,
  bytes: 0,
};

export function MediaPanel({ theme, layout }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme, layout.compact);
  const [playback, setPlayback] = useState(EMPTY);
  const subscription = useSubscription(mediaStream, { source: "test-pattern" }, (bytes) => {
    const frame = decodeMediaFrame(bytes);
    if (frame) setPlayback((current) => play(current, frame, bytes.byteLength));
  });
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Test pattern</Text>
      <Text style={styles.muted}>
        {subscription.status === "error" ? subscription.error.message : subscription.status}
      </Text>
      <Picture pixels={playback.picture} cellSize={layout.compact ? 14 : 20} />
      <LevelMeter level={playback.level} styles={styles} />
      <Text style={styles.muted}>
        {playback.videoFrames} video frames ({playback.keyframes} keyframes), {playback.audioChunks}{" "}
        audio chunks, {(playback.bytes / 1024).toFixed(0)} KiB
      </Text>
      <SendFrameBack picture={playback.picture} styles={styles} />
    </View>
  );
}

/** Uploads the picture on screen and shows what the daemon received. */
function SendFrameBack({
  picture,
  styles,
}: {
  picture: Uint8Array | null;
  styles: ReturnType<typeof useStyles>;
}) {
  const sendFrame = useRpc(checkFrame);
  const check = useMutation({ mutationFn: sendFrame });
  const { mutate } = check;
  const send = useCallback(() => {
    if (picture) mutate(picture);
  }, [mutate, picture]);
  return (
    <View style={styles.upload}>
      <Pressable
        accessibilityRole="button"
        disabled={!picture || check.isPending}
        onPress={send}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Send this frame back</Text>
      </Pressable>
      <Text style={styles.muted}>{describeCheck(check)}</Text>
    </View>
  );
}

function describeCheck(
  check: UseMutationResult<RpcOutput<typeof checkFrame>, Error, Uint8Array>,
): string {
  if (check.status === "error") return check.error.message;
  if (check.status === "success")
    return `The daemon received ${check.data.bytes} bytes, sha256 ${check.data.sha256.slice(0, 12)}`;
  return check.status === "pending" ? "Sending…" : "";
}

function play(current: Playback, frame: MediaFrame, bytes: number): Playback {
  if (frame.opcode === MediaOpcode.Audio)
    return {
      ...current,
      level: audioLevel(frame.payload),
      audioChunks: current.audioChunks + 1,
      bytes: current.bytes + bytes,
    };
  return {
    ...current,
    picture: frame.payload,
    videoFrames: current.videoFrames + 1,
    keyframes: current.keyframes + (frame.opcode === MediaOpcode.Keyframe ? 1 : 0),
    bytes: current.bytes + bytes,
  };
}

function audioLevel(samples: Uint8Array): number {
  const view = new DataView(samples.buffer, samples.byteOffset, samples.byteLength);
  let sum = 0;
  const count = samples.byteLength / 2;
  for (let index = 0; index < count; index += 1) sum += view.getInt16(index * 2, true) ** 2;
  return Math.min(1, Math.sqrt(sum / Math.max(1, count)) / 16384);
}

function LevelMeter({ level, styles }: { level: number; styles: ReturnType<typeof useStyles> }) {
  const fill = useMemo(
    () => [styles.meter, { width: `${Math.round(level * 100)}%` as const }],
    [level, styles],
  );
  return (
    <View style={styles.meterTrack}>
      <View style={fill} />
    </View>
  );
}

function Picture({ pixels, cellSize }: { pixels: Uint8Array | null; cellSize: number }) {
  const rows = useMemo(() => pictureRows(pixels, cellSize), [pixels, cellSize]);
  return (
    <View accessibilityLabel="Test pattern video">
      {rows.map((row) => (
        <View key={row.key} style={pictureStyles.row}>
          {row.cells.map((cell) => (
            <View key={cell.key} style={cell.style} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** One style per pixel, row by row. */
function pictureRows(pixels: Uint8Array | null, cellSize: number) {
  const rows = [];
  for (let y = 0; y < VIDEO.height; y += 1) {
    const cells = [];
    for (let x = 0; x < VIDEO.width; x += 1) {
      const offset = (y * VIDEO.width + x) * 3;
      const backgroundColor = pixels
        ? `rgb(${pixels[offset]}, ${pixels[offset + 1]}, ${pixels[offset + 2]})`
        : "transparent";
      cells.push({ key: `${x}`, style: { width: cellSize, height: cellSize, backgroundColor } });
    }
    rows.push({ key: `${y}`, cells });
  }
  return rows;
}

const pictureStyles = StyleSheet.create({ row: { flexDirection: "row" } });

function useStyles(theme: PluginWorkspacePanelProps["theme"], compact: boolean) {
  return useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          padding: compact ? 16 : 24,
          gap: 12,
          backgroundColor: theme.colors.surface0,
        },
        title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" },
        muted: { color: theme.colors.foregroundMuted },
        meterTrack: {
          height: 8,
          borderRadius: 4,
          overflow: "hidden",
          backgroundColor: theme.colors.surface2,
        },
        meter: { height: 8, backgroundColor: theme.colors.accent },
        upload: { gap: 8, alignItems: "flex-start" },
        button: {
          paddingVertical: 8,
          paddingHorizontal: 14,
          borderRadius: 8,
          backgroundColor: theme.colors.accent,
        },
        buttonText: { color: theme.colors.accentForeground },
      }),
    [theme, compact],
  );
}
