import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as XLSX from "xlsx";
import type { WorkspaceFilePreviewProps } from "@/components/workspace-file-previews/types";

const MAX_ROWS = 200;
const MAX_COLUMNS = 40;

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toLocaleString();
  }
  return String(value);
}

function parseWorkbook(bytes: Uint8Array): {
  sheetName: string;
  rows: { key: string; cells: { key: string; value: string }[] }[];
  truncated: boolean;
  error: string | null;
} {
  try {
    const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
    const sheetName = workbook.SheetNames[0] ?? "Sheet 1";
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return { sheetName, rows: [], truncated: false, error: null };
    }
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
    });
    const rows = rawRows.slice(0, MAX_ROWS).map((row, rowIndex) => ({
      key: `row-${rowIndex + 1}-${row.map((cell) => stringifyCell(cell)).join("|")}`,
      cells: row.slice(0, MAX_COLUMNS).map((cell, columnIndex) => ({
        key: `column-${columnIndex + 1}-${stringifyCell(cell)}`,
        value: stringifyCell(cell),
      })),
    }));
    return {
      sheetName,
      rows,
      truncated: rawRows.length > MAX_ROWS || rawRows.some((row) => row.length > MAX_COLUMNS),
      error: null,
    };
  } catch (error) {
    return {
      sheetName: "Spreadsheet",
      rows: [],
      truncated: false,
      error: error instanceof Error ? error.message : "Failed to render spreadsheet",
    };
  }
}

export function WorkspaceSpreadsheetPreview({ bytes }: WorkspaceFilePreviewProps) {
  const preview = useMemo(() => parseWorkbook(bytes), [bytes]);

  if (preview.error) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{preview.error}</Text>
      </View>
    );
  }

  if (preview.rows.length === 0) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.emptyText}>Spreadsheet is empty</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {preview.sheetName}
        </Text>
        {preview.truncated ? <Text style={styles.meta}>Preview limited</Text> : null}
      </View>
      <ScrollView style={styles.scroll}>
        <ScrollView horizontal contentContainerStyle={styles.table}>
          {preview.rows.map((row) => (
            <View key={row.key} style={styles.row}>
              {row.cells.map((cell) => (
                <View key={cell.key} style={styles.cell}>
                  <Text style={styles.cellText} numberOfLines={2}>
                    {cell.value}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  scroll: {
    flex: 1,
  },
  table: {
    padding: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
  },
  cell: {
    width: 160,
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  cellText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
