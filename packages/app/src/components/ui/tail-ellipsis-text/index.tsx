import { useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { readMeasuredWidth } from "@/hooks/use-container-width";
import { resolveTailEllipsis, tailEllipsisCandidates } from "./resolve";

interface MeasuredWidths {
  text: string;
  full?: number;
  candidates: (number | undefined)[];
}

/**
 * One line of text that shrinks with its row and, when it does not fit, ends on a whole word
 * and an ellipsis ("Ten second…"), never on a space. It measures itself, so it stays invisible
 * for the frame before its widths are known.
 */
export function TailEllipsisText({
  text,
  style,
  testID,
}: {
  text: string;
  /** Text styles; the component owns its layout. */
  style: StyleProp<TextStyle>;
  testID?: string;
}) {
  const candidates = useMemo(() => tailEllipsisCandidates(text), [text]);
  const [boxWidth, setBoxWidth] = useState<number | undefined>(undefined);
  const [widths, setWidths] = useState<MeasuredWidths>({ text, candidates: [] });
  const current = widths.text === text ? widths : { text, candidates: [] };

  const onBoxLayout = useCallback((event: LayoutChangeEvent) => {
    const width = readMeasuredWidth(event);
    if (width !== null) setBoxWidth(width);
  }, []);
  const measure = useCallback(
    (slot: "full" | number) => (event: LayoutChangeEvent) => {
      const width = readMeasuredWidth(event);
      if (width === null) return;
      setWidths((previous) => {
        const base = previous.text === text ? previous : { text, candidates: [] };
        if (slot === "full") return { ...base, full: width };
        const next = [...base.candidates];
        next[slot] = width;
        return { ...base, candidates: next };
      });
    },
    [text],
  );

  const decision = resolveTailEllipsis({
    candidates,
    measurements: { boxWidth, fullWidth: current.full, candidateWidths: current.candidates },
  });
  const shownText = decision.kind === "truncated" ? decision.text : text;

  return (
    <View style={styles.box} onLayout={onBoxLayout}>
      {/* Sizes the box: as wide as the text, or as the row allows. */}
      <Text
        style={[style, styles.sizer]}
        numberOfLines={1}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {text}
      </Text>
      <View style={styles.shown} pointerEvents="none">
        <Text
          style={[style, styles.shownText, decision.kind === "measuring" && styles.measuring]}
          numberOfLines={1}
          ellipsizeMode="tail"
          testID={testID}
        >
          {shownText}
        </Text>
      </View>
      {/* Keyed by the text, so new text remounts the measurer and every width is measured again.
          A retained node whose size does not change emits no new layout event. */}
      <View
        key={text}
        style={styles.measurer}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={[style, styles.measured]} numberOfLines={1} onLayout={measure("full")}>
          {text}
        </Text>
        {candidates.map((candidate, index) => (
          <Text
            key={candidate}
            style={[style, styles.measured]}
            numberOfLines={1}
            onLayout={measure(index)}
          >
            {candidate}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // A row, so the absolute measurer below lays its text out at full width on native too.
  box: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
  },
  sizer: {
    minWidth: 0,
    flexShrink: 1,
    opacity: 0,
  },
  shown: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  shownText: {
    minWidth: 0,
    flexShrink: 1,
  },
  measuring: {
    opacity: 0,
  },
  measurer: {
    position: "absolute",
    left: 0,
    top: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    opacity: 0,
  },
  measured: {
    flexShrink: 0,
  },
});
