import { memo, useMemo } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface AvatarProps {
  name: string;
  imageUrl?: string | null;
  size?: number;
  online?: boolean;
  offline?: boolean;
}

const PALETTE = [
  "#e57373",
  "#ba68c8",
  "#7986cb",
  "#64b5f6",
  "#4db6ac",
  "#81c784",
  "#dce775",
  "#ffb74d",
  "#a1887f",
  "#90a4ae",
];

export const Avatar = memo(function Avatar({
  name,
  imageUrl,
  size = 28,
  online,
  offline,
}: AvatarProps) {
  const initials = useMemo(() => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
  }, [name]);

  const bg = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) | 0;
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
  }, [name]);

  const dot = online ? styles.online : offline ? styles.offline : null;

  return (
    <View style={{ width: size, height: size }}>
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={[styles.image, { width: size, height: size, borderRadius: size * 0.22 }]}
        />
      ) : (
        <View
          style={[
            styles.fallback,
            { width: size, height: size, borderRadius: size * 0.22, backgroundColor: bg },
          ]}
        >
          <Text style={[styles.fallbackText, { fontSize: size * 0.4 }]}>{initials}</Text>
        </View>
      )}
      {dot ? (
        <View
          style={[
            styles.dotBase,
            dot,
            {
              width: Math.max(8, size * 0.3),
              height: Math.max(8, size * 0.3),
              borderRadius: Math.max(8, size * 0.3) / 2,
              right: -1,
              bottom: -1,
            },
          ]}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  image: {
    backgroundColor: theme.colors.surface1,
  },
  fallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  fallbackText: {
    color: "#ffffff",
    fontWeight: "600",
  },
  dotBase: {
    position: "absolute",
    borderWidth: 2,
    borderColor: theme.colors.surface0,
  },
  online: {
    backgroundColor: "#3ecf4f",
  },
  offline: {
    backgroundColor: theme.colors.foregroundMuted,
  },
}));
