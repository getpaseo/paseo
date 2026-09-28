import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  ScrollView as RNScrollView,
  View,
  type LayoutChangeEvent,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import type { ASTNode } from "react-native-markdown-display";
import { withUnistyles } from "react-native-unistyles";
import { MarkdownTableCellText } from "@/components/markdown-text-selection";
import { isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

// A GFM row is a flex row, so nothing lines its cells up with the rows around it. Every
// cell in a column gets the same flex basis and grow factor, derived from the column's text,
// so all rows resolve to the same column widths. A column never gets narrower than its
// longest word, and holds a few words per line before wrapping. A table whose columns
// cannot fit at that width scrolls inside the message instead of squeezing every column
// to width / N.
// Estimates run slightly wide so semibold headers don't break mid-word.
const CHARACTER_WIDTH_EM = 0.62;
const MIN_COLUMN_EM = 4;
const WRAP_COLUMN_EM = 5;
const MAX_COLUMN_EM = 16;
// Matches the right border on markdown-styles `th` / `td`.
const CELL_BORDER_WIDTH = 1;
const WORD_BREAK = /[\s-]+/;
const OVERFLOW_EPSILON = 1;

const ScrollView = isWeb ? RNScrollView : GHScrollView;

interface MarkdownTableColumn {
  minWidth: number;
  preferredWidth: number;
}

const MarkdownTableColumnsContext = createContext<readonly MarkdownTableColumn[]>([]);

function nodeText(node: ASTNode): string {
  // Container nodes (th, textgroup, link) carry no `content`, despite the library's type.
  return (node.content ?? "") + node.children.map(nodeText).join("");
}

interface MarkdownTableMetrics {
  fontSize: number;
  cellPadding: number;
}

function getMarkdownTableColumns(
  table: ASTNode,
  { fontSize, cellPadding }: MarkdownTableMetrics,
): MarkdownTableColumn[] {
  // markdown-it emits exactly one cell per header column in every row.
  const rows = table.children.flatMap((section) => section.children);
  const columns = rows[0].children.map(() => ({ longestWord: 0, longestText: 0 }));
  for (const row of rows) {
    row.children.forEach((cell, index) => {
      const text = nodeText(cell);
      const longestWord = Math.max(...text.split(WORD_BREAK).map((word) => word.length));
      const column = columns[index];
      column.longestWord = Math.max(column.longestWord, longestWord);
      column.longestText = Math.max(column.longestText, text.length);
    });
  }

  const chrome = cellPadding * 2 + CELL_BORDER_WIDTH;
  function toWidth(em: number): number {
    const clampedEm = Math.min(MAX_COLUMN_EM, Math.max(MIN_COLUMN_EM, em));
    return Math.ceil(clampedEm * fontSize) + chrome;
  }
  return columns.map(({ longestWord, longestText }) => {
    const wordEm = longestWord * CHARACTER_WIDTH_EM;
    const textEm = longestText * CHARACTER_WIDTH_EM;
    return {
      minWidth: toWidth(Math.max(wordEm, Math.min(textEm, WRAP_COLUMN_EM))),
      preferredWidth: toWidth(textEm),
    };
  });
}

interface MarkdownTableProps extends MarkdownTableMetrics {
  table: ASTNode;
  frameStyle: ViewStyle;
  dataSet?: ViewProps["dataSet"];
  children: ReactNode;
}

function MarkdownTableFrame({
  table,
  frameStyle,
  dataSet,
  fontSize,
  cellPadding,
  children,
}: MarkdownTableProps) {
  const columns = useMemo(
    () => getMarkdownTableColumns(table, { fontSize, cellPadding }),
    [table, fontSize, cellPadding],
  );
  // Sized explicitly: web would otherwise size the content by its unwrapped text width.
  const contentStyle = useMemo(() => {
    const columnsWidth = columns.reduce((width, column) => width + column.minWidth, 0);
    return inlineUnistylesStyle({ width: columnsWidth, minWidth: "100%" as const });
  }, [columns]);
  const [frameWidth, setFrameWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setFrameWidth(event.nativeEvent.layout.width);
  }, []);
  const onContentSizeChange = useCallback((width: number) => {
    setContentWidth(width);
  }, []);
  const overflows = frameWidth > 0 && contentWidth > frameWidth + OVERFLOW_EPSILON;

  return (
    <ScrollView
      // Android only shows a persistent scrollbar that was on when the view was created; turning
      // it on later leaves the bar hidden until the first scroll. Remount once overflow is known.
      key={overflows ? "overflows" : "fits"}
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      // Keeps the Android scrollbar visible at rest on a table that scrolls; a column edge can
      // line up with the frame edge, and nothing else shows the table continues. Android draws
      // a persistent bar even when nothing scrolls, so tables that fit leave it off.
      persistentScrollbar={overflows}
      onLayout={onLayout}
      onContentSizeChange={onContentSizeChange}
      style={frameStyle}
      contentContainerStyle={contentStyle}
    >
      <View style={TABLE_FILL} dataSet={dataSet}>
        <MarkdownTableColumnsContext value={columns}>{children}</MarkdownTableColumnsContext>
      </View>
    </ScrollView>
  );
}

export const MarkdownTable = withUnistyles(MarkdownTableFrame, (theme) => ({
  fontSize: theme.fontSize.content,
  cellPadding: theme.spacing[2],
}));

interface MarkdownTableCellProps {
  cell: ASTNode;
  cellStyle: ViewStyle;
  dataSet?: ViewProps["dataSet"];
  children: ReactNode;
}

export function MarkdownTableCell({ cell, cellStyle, dataSet, children }: MarkdownTableCellProps) {
  const { minWidth, preferredWidth } = useContext(MarkdownTableColumnsContext)[cell.index];
  // Column widths vary per table; keep them out of the web Unistyles CSS registry.
  const widthStyle = useMemo(
    () => inlineUnistylesStyle({ flexBasis: minWidth, flexGrow: preferredWidth }),
    [minWidth, preferredWidth],
  );

  return (
    <MarkdownTableCellText>
      <View style={[cellStyle, CELL_FILL, widthStyle]} dataSet={dataSet}>
        {children}
      </View>
    </MarkdownTableCellText>
  );
}

// A table that fits fills the message; its columns share the spare width in proportion to
// their preferred width.
const TABLE_FILL: ViewStyle = { flex: 1 };
const CELL_FILL: ViewStyle = { flexShrink: 0 };
