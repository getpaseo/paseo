import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { density } from "@/styles/density";
import { openPlanReview } from "./model";
import { usePlanSourcePointer } from "./pointer";

export function PlanReviewSource({
  model,
  disabled,
  onComment,
}: {
  model: ReturnType<typeof openPlanReview>;
  disabled: boolean;
  onComment: () => void;
}) {
  const { height } = useWindowDimensions();
  const scrollStyle = useMemo(() => ({ maxHeight: Math.min(480, height * 0.45) }), [height]);
  const draft = useSyncExternalStore(model.subscribe, model.getState);
  const sourceLines = useMemo(() => {
    let offset = 0;
    return model.lines.map((line, index) => {
      const key = String(offset);
      offset += line.length + 1;
      return { key, line, number: index + 1 };
    });
  }, [model]);
  const root = useRef<View>(null);
  const anchor = useRef(Number(draft.start));
  const complete = useCallback(() => {
    onComment();
  }, [onComment]);
  usePlanSourcePointer({ root, anchor, model, disabled, onComplete: complete });
  const select = useCallback(
    (line: number) => {
      anchor.current = line;
      model.selectLines(anchor.current, line);
      complete();
    },
    [model, complete],
  );

  return (
    <ScrollView
      style={scrollStyle}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      testID="plan-review-scroll"
    >
      <View ref={root} testID="plan-review-source">
        {sourceLines.map(({ key, line, number }) => (
          <SourceLine
            key={key}
            line={line}
            number={number}
            selected={
              draft.commentTarget === "lines" &&
              number >= Number(draft.start) &&
              number <= Number(draft.end)
            }
            disabled={disabled}
            onSelect={select}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function SourceLine({
  line,
  number,
  selected,
  disabled,
  onSelect,
}: {
  line: string;
  number: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (line: number) => void;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  const select = useCallback(() => onSelect(number), [number, onSelect]);
  const accessibilityState = useMemo(() => ({ selected, disabled }), [selected, disabled]);
  const dataSet = useMemo(() => ({ planLine: String(number) }), [number]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={`${t("planReview.lineRange", { start: number, end: number })}: ${line}`}
      accessibilityState={accessibilityState}
      aria-pressed={isWeb ? selected : undefined}
      dataSet={dataSet}
      testID={`plan-review-line-${number}`}
      disabled={disabled}
      onPress={select}
      onHoverIn={hoverIn}
      onHoverOut={hoverOut}
      onFocus={focus}
      onBlur={blur}
      style={[
        styles.line,
        selected && styles.selected,
        hovered && styles.hovered,
        focused && styles.focused,
      ]}
      highlightStyle={styles.hovered}
    >
      <Text style={styles.number} selectable={false}>
        {number}
      </Text>
      <Text style={styles.text} selectable={false}>
        {line || "\u200B"}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: density.tightRowHeight,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: "transparent",
    borderLeftWidth: theme.spacing[1],
  },
  selected: { backgroundColor: theme.colors.surface2, borderLeftColor: theme.colors.accent },
  hovered: { backgroundColor: theme.colors.interactionHighlight },
  focused: { borderColor: theme.colors.accent },
  number: {
    minWidth: 24,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  text: {
    flex: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 20,
  },
}));
