import { useCallback, useMemo, useRef, type ComponentType, type RefObject } from "react";
import { Check } from "lucide-react-native";
import { Text, View, type ScrollView as NativeScrollView } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView } from "@/components/ui/scroll-view";
import { useRevealActiveItem } from "@/components/ui/scroll-reveal";
import { Shortcut } from "@/components/ui/shortcut";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

type RowIcon = ComponentType<{ size?: number; color?: string }>;

export interface ResultRow {
  id: string;
  title: string;
  subtitle: string | null;
  icon: RowIcon;
  testID: string;
}

/** What the list says when it has no rows to show. */
export type ResultListNotice =
  | { kind: "pending"; text: string }
  | { kind: "empty"; text: string }
  | { kind: "error"; text: string };

interface ResultListProps {
  rows: ResultRow[];
  activeIndex: number;
  /** Shown in place of the rows when there are none, or above them for an error. */
  notice: ResultListNotice | null;
  onSelect: (index: number) => void;
  disabled?: boolean;
  testID: string;
}

const ENTER_KEYS = ["Enter"];
// Fixed line heights make a two-line row the same height on every platform.
const TITLE_LINE_HEIGHT = 18;
const SUBTITLE_LINE_HEIGHT = 16;

function RowGlyph({ icon: Icon, size, color }: { icon: RowIcon; size: number; color?: string }) {
  return <Icon size={size} color={color} />;
}
const MutedRowGlyph = withUnistyles(RowGlyph, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const AccentCheck = withUnistyles(Check, (theme: Theme) => ({ color: theme.colors.accent }));
const ThemedSpinner = withUnistyles(LoadingSpinner, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

/** Enter commits the active row when there is a keyboard; on touch, a check marks the choice. */
function ActiveMark() {
  const keyboardPresent = useHardwareKeyboardPresent();
  return keyboardPresent ? <Shortcut keys={ENTER_KEYS} /> : <AccentCheck size={16} />;
}

function ResultRowView({
  row,
  index,
  active,
  disabled,
  activeItemRef,
  onActiveLayout,
  onSelect,
}: {
  row: ResultRow;
  index: number;
  active: boolean;
  disabled: boolean;
  activeItemRef: RefObject<View | null>;
  onActiveLayout: () => void;
  onSelect: (index: number) => void;
}) {
  const handlePress = useCallback(() => onSelect(index), [index, onSelect]);
  const style = useMemo(
    () => [
      settingsStyles.row,
      styles.row,
      index > 0 && settingsStyles.rowBorder,
      active && styles.rowActive,
    ],
    [active, index],
  );
  const accessibilityState = useMemo(() => ({ selected: active, disabled }), [active, disabled]);
  return (
    <PressHighlight
      ref={active ? activeItemRef : undefined}
      onLayout={active ? onActiveLayout : undefined}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={handlePress}
      // Tabbing to a row picks it, so Enter commits the row that has focus.
      onFocus={handlePress}
      style={style}
      highlightStyle={styles.rowActive}
      testID={row.testID}
    >
      <View style={styles.iconSlot}>
        <MutedRowGlyph icon={row.icon} size={16} />
      </View>
      <View style={styles.rowText}>
        <Text style={[settingsStyles.rowTitle, styles.rowTitle]} numberOfLines={1}>
          {row.title}
        </Text>
        {row.subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {row.subtitle}
          </Text>
        ) : null}
      </View>
      {/* Reserved on every row so the active row's mark never shifts its text. */}
      <View style={styles.trailingSlot}>{active ? <ActiveMark /> : null}</View>
    </PressHighlight>
  );
}

/**
 * A card of choices with one active row. Arrow keys, taps, and keyboard focus move the active
 * row; the sheet's primary action commits it. The list keeps the active row scrolled into view.
 */
export function ResultList({
  rows,
  activeIndex,
  notice,
  onSelect,
  disabled = false,
  testID,
}: ResultListProps) {
  const scrollRef = useRef<NativeScrollView>(null);
  const listKey = useMemo(() => rows.map((row) => row.id).join("\u0000"), [rows]);
  const { activeItemRef, contentRef, onItemLayout, onViewportLayout, onScroll } =
    useRevealActiveItem({ activeIndex, listKey, scrollRef });
  const showNotice = notice && (rows.length === 0 || notice.kind === "error");

  return (
    <View style={styles.frame}>
      {showNotice ? (
        <View style={[settingsStyles.card, styles.noticeCard]} testID={`${testID}-notice`}>
          {notice.kind === "pending" ? <ThemedSpinner size={14} /> : null}
          <Text
            style={notice.kind === "error" ? styles.noticeError : styles.noticeText}
            numberOfLines={2}
          >
            {notice.text}
          </Text>
        </View>
      ) : null}
      {rows.length > 0 ? (
        <View style={[settingsStyles.card, styles.listCard]}>
          <ScrollView
            ref={scrollRef}
            keyboardShouldPersistTaps="always"
            onLayout={onViewportLayout}
            onScroll={onScroll}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            testID={testID}
          >
            <View ref={contentRef} collapsable={false}>
              {rows.map((row, index) => (
                <ResultRowView
                  key={row.id}
                  row={row}
                  index={index}
                  active={index === activeIndex}
                  disabled={disabled}
                  activeItemRef={activeItemRef}
                  onActiveLayout={onItemLayout}
                  onSelect={onSelect}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[3],
  },
  listCard: {
    flexShrink: 1,
    minHeight: 0,
  },
  // Every row is as tall as a two-line row, so rows without a subtitle do not break the rhythm.
  row: {
    minHeight: theme.spacing[3] * 2 + TITLE_LINE_HEIGHT + SUBTITLE_LINE_HEIGHT,
    paddingVertical: theme.spacing[3],
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  rowActive: {
    backgroundColor: theme.colors.surface2,
  },
  iconSlot: {
    width: 16,
    alignItems: "center",
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    lineHeight: TITLE_LINE_HEIGHT,
  },
  rowSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: SUBTITLE_LINE_HEIGHT,
  },
  trailingSlot: {
    minWidth: theme.spacing[6],
    alignItems: "flex-end",
  },
  noticeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  noticeText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  noticeError: {
    flex: 1,
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
  },
}));
