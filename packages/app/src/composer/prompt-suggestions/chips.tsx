import { memo, useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { PromptSuggestion } from "@getpaseo/protocol/messages";
import { composerPillStyles, resolveComposerPillClearance } from "@/composer/pill-styles";
import { useIsCompactFormFactor } from "@/constants/layout";

interface PromptSuggestionChipsProps {
  suggestions: readonly PromptSuggestion[];
  onSelect: (text: string) => void;
}

export const PromptSuggestionChips = memo(function PromptSuggestionChips({
  suggestions,
  onSelect,
}: PromptSuggestionChipsProps) {
  const isCompact = useIsCompactFormFactor();
  if (suggestions.length === 0) return null;
  return (
    <View
      style={[styles.row, { marginBottom: resolveComposerPillClearance(isCompact) }]}
      testID="composer-prompt-suggestion-chips"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
      >
        {suggestions.map((suggestion) => (
          <PromptSuggestionChip key={suggestion.id} suggestion={suggestion} onSelect={onSelect} />
        ))}
      </ScrollView>
    </View>
  );
});

const PromptSuggestionChip = memo(function PromptSuggestionChip({
  suggestion,
  onSelect,
}: {
  suggestion: PromptSuggestion;
  onSelect: (text: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(suggestion.text), [onSelect, suggestion.text]);
  return (
    <Pressable
      onPress={handlePress}
      style={chipStyle}
      accessibilityRole="button"
      accessibilityLabel={t("composer.promptSuggestions.chipAccessibilityLabel", {
        text: suggestion.text,
      })}
    >
      <Text numberOfLines={1} style={[composerPillStyles.label, styles.chipLabel]}>
        {suggestion.text}
      </Text>
    </Pressable>
  );
});

function chipStyle({ pressed }: { pressed: boolean }) {
  return [composerPillStyles.body, styles.chip, pressed && composerPillStyles.bodyActive];
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
  },
  chip: {
    marginRight: theme.spacing[2],
    maxWidth: 320,
  },
  chipLabel: {
    flexShrink: 1,
  },
}));
