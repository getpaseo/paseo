import { useMemo } from "react";
import { Text } from "react-native";
import { activeWordIndex, type TimedWord } from "../shared/voice-settings";

export interface WordHighlightColors {
  foreground: string;
  muted: string;
  accent: string;
}

export interface WordHighlightProps {
  words: readonly TimedWord[];
  elapsedSeconds: number;
  colors: WordHighlightColors;
}

export function WordHighlight({ words, elapsedSeconds, colors }: WordHighlightProps) {
  const active = activeWordIndex(words, elapsedSeconds);
  const styles = useMemo(
    () => ({
      line: { color: colors.muted, fontSize: 18, lineHeight: 28 },
      active: { color: colors.accent, fontWeight: "700" as const },
      spoken: { color: colors.foreground },
    }),
    [colors],
  );
  function styleFor(index: number) {
    if (index === active) return styles.active;
    return index < active ? styles.spoken : undefined;
  }
  return (
    <Text testID="word-highlight" style={styles.line}>
      {words.map((entry, index) => (
        <Text
          key={`${entry.start}-${entry.word}`}
          testID={index === active ? "word-active" : undefined}
          style={styleFor(index)}
        >
          {index === 0 ? entry.word : ` ${entry.word}`}
        </Text>
      ))}
    </Text>
  );
}
