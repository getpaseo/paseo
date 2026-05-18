import { memo, useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Sparkles } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";

const ThemedSparkles = withUnistyles(Sparkles);

const accentColorMapping = (theme: { colors: { accent: string } }) => ({
  color: theme.colors.accent,
});

const SUGGESTION_CHIPS = [
  "Summarize the key points of this project",
  "Help me debug an issue",
  "Write a test for a component",
];

interface WelcomeEmptyStateProps {
  onSuggestionPress?: (text: string) => void;
}

export const WelcomeEmptyState = memo(function WelcomeEmptyState({
  onSuggestionPress,
}: WelcomeEmptyStateProps) {
  return (
    <View style={styles.container}>
      <View style={styles.iconContainer}>
        <ThemedSparkles size={48} uniProps={accentColorMapping} />
      </View>
      <Text style={styles.heading}>How can I help you today?</Text>
      {onSuggestionPress && (
        <View style={styles.chipsContainer}>
          {SUGGESTION_CHIPS.map((chip) => (
            <SuggestionChip key={chip} text={chip} onPress={onSuggestionPress} />
          ))}
        </View>
      )}
    </View>
  );
});

const chipPressStyle = ({ pressed }: { pressed: boolean }) => [
  styles.chip,
  pressed && styles.chipPressed,
];

const SuggestionChip = memo(function SuggestionChip({
  text,
  onPress,
}: {
  text: string;
  onPress: (text: string) => void;
}) {
  const handlePress = useCallback(() => onPress(text), [onPress, text]);

  return (
    <Pressable onPress={handlePress} style={chipPressStyle}>
      <Text style={styles.chipText}>{text}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[12],
    paddingHorizontal: theme.spacing[6],
  },
  iconContainer: {
    marginBottom: theme.spacing[4],
  },
  heading: {
    fontSize: theme.fontSize.xl,
    fontWeight: "500",
    color: theme.colors.foreground,
    textAlign: "center",
    marginBottom: theme.spacing[6],
  },
  chipsContainer: {
    gap: theme.spacing[2],
    alignItems: "center",
    width: "100%",
    maxWidth: 400,
  },
  chip: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    width: "100%",
  },
  chipPressed: {
    backgroundColor: theme.colors.surface2,
  },
  chipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
