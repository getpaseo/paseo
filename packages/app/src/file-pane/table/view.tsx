import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, ScrollView, Text, TextInput, View, type ListRenderItemInfo } from "react-native";
import { StyleSheet, UnistylesRuntime, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react-native";
import { AppearanceStyleBoundary } from "@/components/appearance-style-boundary";
import { Button } from "@/components/ui/button";
import { createControlGeometry } from "@/components/ui/control-geometry";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import {
  nextTableSort,
  parseDelimitedTable,
  tableRowsInView,
  type TableColumn,
  type TableFilters,
  type TableGrid,
  type TableRow,
  type TableSort,
  type TableSortDirection,
} from "./model";

const ThemedFilterInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedArrowUpDown = withUnistyles(ArrowUpDown);
const sortedIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const unsortedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

const SORT_ICON_SIZE = 12;
const MIN_COLUMN_WIDTH = 96;
const MAX_COLUMN_WIDTH = 320;
// Widths come from the content instead of a measure pass, so the sample bounds
// the cost on a file with a million rows. A later row wider than the sample
// truncates rather than widening its column.
const WIDTH_SAMPLE_ROWS = 200;
const CELL_PADDING = 24;
// The header label shares its cell with the sort arrows and the button's own
// padding, so a column has to be wide enough for both or the label wraps and
// the header row stops lining up with the data.
const HEADER_CHROME = 52;
const MONO_CHARACTER_RATIO = 0.62;
// Shared by the rendered cell and by getItemLayout, so a row's reported height
// is the height it actually draws at.
const CELL_LINE_HEIGHT_RATIO = 1.45;

interface TableCellStyle {
  width: number;
}

const EMPTY_FILTERS: TableFilters = new Map();

interface FileTablePreviewProps {
  content: string;
  filePath: string;
  testID?: string;
}

export function FileTablePreview({ content, filePath, testID }: FileTablePreviewProps) {
  const { t } = useTranslation();
  const table = useMemo(() => parseDelimitedTable(content, filePath), [content, filePath]);
  const [sort, setSort] = useState<TableSort | null>(null);
  const [filters, setFilters] = useState<TableFilters>(EMPTY_FILTERS);
  const rows = useMemo(
    () => tableRowsInView({ rows: table.rows, filters, sort }),
    [table.rows, filters, sort],
  );

  const toggleSort = useCallback((column: number) => {
    setSort((current) => nextTableSort(current, column));
  }, []);
  const setColumnFilter = useCallback((column: number, term: string) => {
    setFilters((current) => {
      const next = new Map(current);
      if (term.length === 0) next.delete(column);
      else next.set(column, term);
      return next;
    });
  }, []);

  if (table.columns.length === 0) {
    return (
      <View style={styles.centerState} testID={testID}>
        <Text style={styles.emptyText}>{t("panels.file.table.empty")}</Text>
      </View>
    );
  }

  const hasRows = rows.length > 0;
  const emptyMessage = table.rows.length === 0 ? "empty" : "noMatches";

  return (
    <View style={styles.container} testID={testID}>
      {/* The grid sizes itself from the code font, which appearance settings
          patch at runtime without re-rendering React. Remounting it there keeps
          the column widths and row height honest. Sort and filter state lives
          out here so it survives that remount. */}
      <AppearanceStyleBoundary>
        <TableSurface
          table={table}
          rows={rows}
          filters={filters}
          sort={sort}
          onSort={toggleSort}
          onFilter={setColumnFilter}
        />
      </AppearanceStyleBoundary>
      {hasRows ? null : (
        // Outside the scroller so a wide table cannot push the message off screen
        // while the filter that emptied it stays reachable.
        <View style={styles.centerState}>
          <Text style={styles.emptyText}>{t(`panels.file.table.${emptyMessage}`)}</Text>
        </View>
      )}
      <View style={styles.footer}>
        <Text style={styles.footerText} testID="file-table-row-count">
          {rowCountLabel({ visible: rows.length, total: table.rows.length, t })}
        </Text>
      </View>
    </View>
  );
}

interface TableSurfaceProps {
  table: TableGrid;
  rows: TableRow[];
  filters: TableFilters;
  sort: TableSort | null;
  onSort(column: number): void;
  onFilter(column: number, term: string): void;
}

function TableSurface({ table, rows, filters, sort, onSort, onFilter }: TableSurfaceProps) {
  const theme = UnistylesRuntime.getTheme();
  const cellWidths = useMemo(
    () => columnWidths({ table, fontSize: theme.fontSize.code }),
    [table, theme.fontSize.code],
  );
  const cellStyles = useMemo(
    () => cellWidths.map((width) => inlineUnistylesStyle({ width })),
    [cellWidths],
  );
  const rowHeight = Math.round(theme.fontSize.code * CELL_LINE_HEIGHT_RATIO) + theme.spacing[2] * 2;
  const gridStyle = useMemo(() => {
    const totalWidth = cellWidths.reduce((sum, width) => sum + width, 0);
    return inlineUnistylesStyle({ width: totalWidth });
  }, [cellWidths]);
  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<TableRow>) => (
      <TableBodyRow row={item} columns={table.columns} cellStyles={cellStyles} />
    ),
    [table.columns, cellStyles],
  );
  const rowLayout = useCallback(
    (_data: ArrayLike<TableRow> | null | undefined, index: number) => ({
      length: rowHeight,
      offset: rowHeight * index,
      index,
    }),
    [rowHeight],
  );
  const hasRows = rows.length > 0;

  // The header, the filters, and the rows share one horizontal scroller so a
  // cell never drifts out from under its column.
  return (
    <ScrollView
      horizontal
      style={hasRows ? styles.gridFill : styles.gridChrome}
      contentContainerStyle={styles.gridScrollContent}
    >
      <View style={gridStyle}>
        <View style={styles.headerRow}>
          {table.columns.map((column) => (
            <TableHeaderCell
              key={column.index}
              column={column}
              cellStyle={cellStyles[column.index]}
              sort={sort}
              onPress={onSort}
            />
          ))}
        </View>
        <View style={styles.filterRow}>
          {table.columns.map((column) => (
            <TableFilterCell
              key={column.index}
              column={column}
              cellStyle={cellStyles[column.index]}
              term={filters.get(column.index) ?? ""}
              onChange={onFilter}
            />
          ))}
        </View>
        {hasRows ? (
          <FlatList
            data={rows}
            renderItem={renderRow}
            keyExtractor={rowKey}
            getItemLayout={rowLayout}
            style={styles.body}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

function rowKey(row: TableRow): string {
  return String(row.index);
}

interface RowCountLabelInput {
  visible: number;
  total: number;
  t: TFunction;
}

// The count that carries the plural is the total, so a filtered label reads
// "1 of 12 rows" rather than "1 of 12 row".
function rowCountLabel({ visible, total, t }: RowCountLabelInput): string {
  const plural = total === 1 ? "one" : "other";
  if (visible === total) {
    return t(`panels.file.table.rowCount.${plural}`, { count: total });
  }
  return t(`panels.file.table.filteredRowCount.${plural}`, { count: total, visible });
}

function columnLabel(column: TableColumn, t: TFunction): string {
  return column.label.length > 0 ? column.label : t("panels.file.table.unnamedColumn");
}

interface SortLabelInput {
  column: string;
  direction: TableSortDirection | null;
  t: TFunction;
}

// The arrow says which way the column points; the label has to say it too for
// anyone who is not looking at it.
function sortLabel({ column, direction, t }: SortLabelInput): string {
  if (direction === "asc") return t("panels.file.table.sortedAscending", { column });
  if (direction === "desc") return t("panels.file.table.sortedDescending", { column });
  return t("panels.file.table.sortColumn", { column });
}

interface TableHeaderCellProps {
  column: TableColumn;
  cellStyle: TableCellStyle;
  sort: TableSort | null;
  onPress(column: number): void;
}

const TableHeaderCell = memo(function TableHeaderCell({
  column,
  cellStyle,
  sort,
  onPress,
}: TableHeaderCellProps) {
  const { t } = useTranslation();
  const sorted = sort?.column === column.index ? sort.direction : null;
  const press = useCallback(() => onPress(column.index), [column.index, onPress]);
  const label = columnLabel(column, t);
  const indicator = useMemo(() => <TableSortIndicator direction={sorted} />, [sorted]);

  return (
    <View style={[styles.headerCell, cellStyle]}>
      <Button
        variant="ghost"
        size="xs"
        onPress={press}
        style={styles.headerButton}
        textStyle={styles.headerLabel}
        trailing={indicator}
        accessibilityLabel={sortLabel({ column: label, direction: sorted, t })}
        testID={`file-table-sort-${column.index}`}
      >
        {label}
      </Button>
    </View>
  );
});

function TableSortIndicator({ direction }: { direction: TableSortDirection | null }) {
  if (direction === "asc") {
    return <ThemedArrowUp size={SORT_ICON_SIZE} uniProps={sortedIconMapping} />;
  }
  if (direction === "desc") {
    return <ThemedArrowDown size={SORT_ICON_SIZE} uniProps={sortedIconMapping} />;
  }
  // The unsorted arrows stay visible so the column reads as sortable and the
  // label does not reflow the first time it is sorted.
  return <ThemedArrowUpDown size={SORT_ICON_SIZE} uniProps={unsortedIconMapping} />;
}

interface TableFilterCellProps {
  column: TableColumn;
  cellStyle: TableCellStyle;
  term: string;
  onChange(column: number, term: string): void;
}

const TableFilterCell = memo(function TableFilterCell({
  column,
  cellStyle,
  term,
  onChange,
}: TableFilterCellProps) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const change = useCallback(
    (nextTerm: string) => onChange(column.index, nextTerm),
    [column.index, onChange],
  );
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  const label = columnLabel(column, t);

  // Deliberately not `FormTextInput`: on a compact native layout that primitive
  // renders `@gorhom/bottom-sheet`'s input, which only works inside a sheet.
  // This row lives in a pane, so it owns the same field chrome directly.
  return (
    <View style={[styles.filterCell, cellStyle]}>
      <ThemedFilterInput
        style={[styles.filterInput, focused ? styles.filterInputFocused : null]}
        // Uncontrolled on purpose: a controlled TextInput replays stale values
        // during fast typing. The seed only matters when the grid remounts under
        // an active filter, which is what an appearance change does.
        defaultValue={term}
        placeholder={t("panels.file.table.filter")}
        accessibilityLabel={t("panels.file.table.filterColumn", { column: label })}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={change}
        onFocus={focus}
        onBlur={blur}
        testID={`file-table-filter-${column.index}`}
      />
    </View>
  );
});

interface TableBodyRowProps {
  row: TableRow;
  columns: TableColumn[];
  cellStyles: TableCellStyle[];
}

const TableBodyRow = memo(function TableBodyRow({ row, columns, cellStyles }: TableBodyRowProps) {
  return (
    <View style={styles.bodyRow} testID={`file-table-body-row-${row.index}`}>
      {columns.map((column) => (
        <Text
          key={column.index}
          selectable
          numberOfLines={1}
          style={[styles.bodyCell, cellStyles[column.index]]}
        >
          {row.cells[column.index]}
        </Text>
      ))}
    </View>
  );
});

interface ColumnWidthInput {
  table: { columns: TableColumn[]; rows: TableRow[] };
  fontSize: number;
}

function columnWidths({ table, fontSize }: ColumnWidthInput): number[] {
  // One character of slack absorbs the difference between this estimate and
  // whichever mono stack the user configured.
  const characterWidth = fontSize * MONO_CHARACTER_RATIO;
  const sample = table.rows.slice(0, WIDTH_SAMPLE_ROWS);
  return table.columns.map((column) => {
    let longestCell = 0;
    for (const row of sample) {
      longestCell = Math.max(longestCell, row.cells[column.index].length);
    }
    const cellWidth = Math.ceil((longestCell + 1) * characterWidth) + CELL_PADDING;
    const labelWidth = Math.ceil((column.label.length + 1) * characterWidth) + HEADER_CHROME;
    const contentWidth = Math.max(cellWidth, labelWidth);
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, contentWidth));
  });
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    container: {
      flex: 1,
      minHeight: 0,
    },
    gridFill: {
      flex: 1,
      minHeight: 0,
    },
    gridChrome: {
      flexGrow: 0,
      flexShrink: 0,
    },
    gridScrollContent: {
      flexGrow: 1,
    },
    body: {
      flex: 1,
      minHeight: 0,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: theme.colors.surface1,
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
    },
    headerCell: {
      paddingHorizontal: theme.spacing[1],
      paddingVertical: theme.spacing[1],
    },
    headerButton: {
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing[2],
    },
    headerLabel: {
      color: theme.colors.foreground,
      fontWeight: theme.fontWeight.medium,
      flexShrink: 1,
    },
    sortIcon: {
      color: theme.colors.foregroundExtraMuted,
    },
    sortIconActive: {
      color: theme.colors.foreground,
    },
    filterRow: {
      flexDirection: "row",
      alignItems: "center",
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    filterCell: {
      flexDirection: "row",
      paddingHorizontal: theme.spacing[1],
      paddingBottom: theme.spacing[1],
    },
    filterInput: {
      ...geometry.formTextInputSm,
      ...geometry.controlRest,
      flex: 1,
      minWidth: 0,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
    },
    filterInputFocused: {
      ...geometry.controlActive,
    },
    bodyRow: {
      flexDirection: "row",
      alignItems: "center",
    },
    bodyCell: {
      color: theme.colors.foreground,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      lineHeight: Math.round(theme.fontSize.code * CELL_LINE_HEIGHT_RATIO),
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
    },
    footer: {
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      // Right-aligned because a compact layout floats its own control over the
      // bottom-left corner of the pane.
      justifyContent: "flex-end",
      minHeight: 28,
      paddingHorizontal: theme.spacing[3],
      borderTopWidth: theme.borderWidth[1],
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    footerText: {
      color: theme.colors.foregroundExtraMuted,
      fontSize: theme.fontSize.xs,
    },
    centerState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: theme.spacing[4],
    },
    emptyText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
      textAlign: "center",
    },
  };
});
