import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { searchProjectEmojiIcons, type ProjectEmojiIcon } from "@/utils/project-emoji-icons";

interface ProjectEmojiIconPickerProps {
  selectedEmoji: string | null;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

const SELECTED_ACCESSIBILITY_STATE = { selected: true } as const;
const UNSELECTED_ACCESSIBILITY_STATE = { selected: false } as const;

function emojiTestId(emoji: string): string {
  const codePoints = Array.from(emoji, (value) => value.codePointAt(0)?.toString(16) ?? "");
  return `project-emoji-option-${codePoints.join("-")}`;
}

function ProjectEmojiOption({
  entry,
  selected,
  onSelect,
}: {
  entry: ProjectEmojiIcon;
  selected: boolean;
  onSelect: (entry: ProjectEmojiIcon) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(entry);
  }, [entry, onSelect]);
  const optionStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.option,
      selected ? styles.optionSelected : null,
      pressed ? styles.optionPressed : null,
    ],
    [selected],
  );

  return (
    <Pressable
      testID={emojiTestId(entry.emoji)}
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      accessibilityState={selected ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE}
      onPress={handlePress}
      style={optionStyle}
    >
      <Text style={styles.glyph}>{entry.emoji}</Text>
    </Pressable>
  );
}

export function ProjectEmojiIconPicker({
  selectedEmoji,
  onSelect,
  onClose,
}: ProjectEmojiIconPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchProjectEmojiIcons(query), [query]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.project.icon.emojiPickerTitle"),
      search: {
        onChange: setQuery,
        placeholder: t("settings.project.icon.emojiSearchPlaceholder"),
        autoFocus: true,
        testID: "project-emoji-search",
      },
    }),
    [t],
  );
  const handleSelect = useCallback(
    (entry: ProjectEmojiIcon) => {
      onSelect(entry.emoji);
    },
    [onSelect],
  );

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      testID="project-emoji-picker"
      desktopMaxWidth={520}
    >
      {results.length > 0 ? (
        <View style={styles.grid}>
          {results.map((entry) => (
            <ProjectEmojiOption
              key={entry.emoji}
              entry={entry}
              selected={entry.emoji === selectedEmoji}
              onSelect={handleSelect}
            />
          ))}
        </View>
      ) : (
        <Text style={styles.empty}>{t("settings.project.icon.emojiNoResults")}</Text>
      )}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  option: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  optionSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  optionPressed: {
    opacity: 0.7,
  },
  glyph: {
    fontSize: 24,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
}));
