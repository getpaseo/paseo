import { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { catalogIconUrl } from "@/api/catalog";

interface LibraryIconProps {
  /** Remote icon URL (typically GitHub avatar). Resolved through the proxy. */
  sourceUrl: string | null | undefined;
  /** Used for fallback glyph when no icon is available. */
  name: string;
  size?: number;
}

/**
 * Renders a proxied icon with a first-letter fallback on missing/404. Kept
 * tiny because many of these render at once in the library grid.
 *
 * We flip to the lettered fallback on *either* no URL provided or a load
 * failure — Smithery's CDN 404s on a handful of community servers and the
 * raw `<Image>` otherwise renders as an empty grey square.
 */
export function LibraryIcon({ sourceUrl, name, size = 40 }: LibraryIconProps) {
  const uri = sourceUrl ? catalogIconUrl(sourceUrl) : null;
  const [errored, setErrored] = useState(false);

  // Reset the error flag whenever the source actually changes, otherwise a
  // card previously flagged as broken would stay as a letter even after the
  // catalog refresh gives us a new URL.
  useEffect(() => {
    setErrored(false);
  }, [uri]);

  const letter = firstLetter(name);
  const box = { width: size, height: size, borderRadius: size * 0.22 };

  if (uri && !errored) {
    return (
      <View style={[styles.wrap, box]}>
        <Image
          source={{ uri }}
          style={[styles.img, box]}
          resizeMode="cover"
          onError={() => setErrored(true)}
        />
      </View>
    );
  }
  return (
    <View style={[styles.wrap, styles.fallback, box]}>
      <Text style={[styles.letter, { fontSize: size * 0.45 }]}>{letter}</Text>
    </View>
  );
}

function firstLetter(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.charAt(0).toUpperCase();
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  img: {
    position: "absolute",
    top: 0,
    left: 0,
  },
  fallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  letter: {
    fontWeight: "600" as const,
    color: theme.colors.foregroundMuted,
  },
}));
