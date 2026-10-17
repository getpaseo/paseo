import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { z } from "zod";
import { MathMarkup, renderMathMarkup } from "./math-markup";

export const mathMessageSchema = z.object({
  segments: z.array(
    z.union([
      z.object({ kind: z.literal("text"), text: z.string() }),
      z.object({ kind: z.literal("math"), tex: z.string(), display: z.boolean() }),
    ]),
  ),
});

type MathMessageData = z.output<typeof mathMessageSchema>;
type MathSegmentData = MathMessageData["segments"][number];

interface PreparedSegment {
  key: string;
  segment: MathSegmentData;
  markup: string | null;
}

interface Row {
  key: string;
  inline: boolean;
  items: PreparedSegment[];
}

function literalSource(segment: Extract<MathSegmentData, { kind: "math" }>): string {
  return segment.display ? `$$${segment.tex}$$` : `$${segment.tex}$`;
}

/**
 * Consecutive inline content shares one flowing paragraph; display math gets its
 * own row. A sentence such as `Hello $x$ world` has to stay on one line, and a
 * column of segment views would stack it.
 */
function buildRows(prepared: PreparedSegment[]): Row[] {
  const rows: Row[] = [];
  for (const item of prepared) {
    const block = item.segment.kind === "math" && item.segment.display;
    const last = rows[rows.length - 1];
    if (block || last === undefined || !last.inline) {
      rows.push({ key: item.key, inline: !block, items: [item] });
      continue;
    }
    last.items.push(item);
  }
  return rows;
}

/**
 * Draws an assistant message whose math was split out by the transformer.
 *
 * Text uses the timeline's foreground colour. Math is typeset on web and falls
 * back to its delimited source on native.
 *
 * The trade-off of replacing the source item: the host's markdown rendering does
 * not run for these messages, so code fences, tables and links inside a message
 * that also contains math render as plain text. Messages without math are left
 * to the host, which is why the transformer returns undefined for them.
 */
export function MathMessage({ item, theme }: PluginTimelineItemProps<MathMessageData>) {
  const color = theme.colors.foreground;
  const segments = item.data.segments;
  const prepared = useMemo(() => {
    // Segments are immutable per item, so a content-derived key is stable across
    // re-renders and survives a streaming update that appends a segment.
    const seen = new Map<string, number>();
    return segments.map((segment) => {
      const base =
        segment.kind === "math" ? `math:${segment.tex}` : `text:${segment.text.slice(0, 32)}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return {
        key: `${base}#${occurrence}`,
        segment,
        markup:
          segment.kind === "math" && Platform.OS === "web"
            ? renderMathMarkup(segment.tex, segment.display)
            : null,
      };
    });
  }, [segments]);
  const rows = useMemo(() => buildRows(prepared), [prepared]);
  const styles = useMemo(() => ({ body: { color } }), [color]);

  const renderSegment = (entry: PreparedSegment): ReactNode => {
    if (entry.segment.kind === "text") {
      return (
        <Text key={entry.key} selectable style={styles.body}>
          {entry.segment.text}
        </Text>
      );
    }
    return (
      <MathMarkup
        key={entry.key}
        markup={entry.markup}
        source={literalSource(entry.segment)}
        display={entry.segment.display}
        color={color}
      />
    );
  };

  return (
    <View>
      {rows.map((row) =>
        row.inline ? (
          <Text key={row.key} selectable style={styles.body}>
            {row.items.map(renderSegment)}
          </Text>
        ) : (
          <View key={row.key}>{row.items.map(renderSegment)}</View>
        ),
      )}
    </View>
  );
}
