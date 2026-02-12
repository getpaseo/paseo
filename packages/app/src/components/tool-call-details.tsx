import React, { useMemo, ReactNode } from "react";
import { View, Text, Platform, ScrollView as RNScrollView } from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import type { ToolCallDetail } from "@server/server/agent/agent-sdk-types";
import {
  buildLineDiff,
  parseUnifiedDiff,
} from "@/utils/tool-call-parsers";
import { DiffViewer } from "./diff-viewer";
import { getCodeInsets } from "./code-insets";

const ScrollView = Platform.OS === "web" ? RNScrollView : GHScrollView;

// ---- Content Component ----

interface ToolCallDetailsContentProps {
  detail?: ToolCallDetail;
  errorText?: string;
  maxHeight?: number;
  fillAvailableHeight?: boolean;
}

export function ToolCallDetailsContent({
  detail,
  errorText,
  maxHeight,
  fillAvailableHeight = false,
}: ToolCallDetailsContentProps) {
  const resolvedMaxHeight = fillAvailableHeight ? undefined : (maxHeight ?? 300);

  // Compute diff lines for edit type
  const diffLines = useMemo(() => {
    if (!detail || detail.type !== "edit") return undefined;
    // Use pre-computed unified diff if available (e.g., from apply_patch)
    if (detail.unifiedDiff) {
      return parseUnifiedDiff(detail.unifiedDiff);
    }
    return buildLineDiff(detail.oldString ?? "", detail.newString ?? "");
  }, [detail]);

  const sections: ReactNode[] = [];
  const isFullBleed =
    detail?.type === "edit" || detail?.type === "shell" || detail?.type === "write";
  const shouldFill =
    fillAvailableHeight &&
    (detail?.type === "shell" ||
      detail?.type === "edit" ||
      detail?.type === "write" ||
      detail?.type === "read");
  const codeBlockStyle = isFullBleed ? styles.fullBleedBlock : styles.diffContainer;

  if (detail?.type === "shell") {
    const command = detail.command.replace(/\n+$/, "");
    const commandOutput = (detail.output ?? "").replace(/^\n+/, "");
    const hasOutput = commandOutput.length > 0;
    sections.push(
      <View
        key="shell"
        style={[styles.section, shouldFill && styles.fillHeight]}
      >
        <View style={[codeBlockStyle, shouldFill && styles.fillHeight]}>
          <ScrollView
            style={[
              styles.codeVerticalScroll,
              resolvedMaxHeight !== undefined && { maxHeight: resolvedMaxHeight },
              shouldFill && styles.fillHeight,
            ]}
            contentContainerStyle={styles.codeVerticalContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator
              contentContainerStyle={styles.codeHorizontalContent}
            >
              <View style={styles.codeLine}>
                <Text selectable style={styles.scrollText}>
                  <Text style={styles.shellPrompt}>$ </Text>
                  {command}
                  {hasOutput ? `\n\n${commandOutput}` : ""}
                </Text>
              </View>
            </ScrollView>
          </ScrollView>
        </View>
      </View>
    );
  } else if (detail?.type === "edit") {
    sections.push(
      <View
        key="edit"
        style={[styles.section, shouldFill && styles.fillHeight]}
      >
        {diffLines ? (
          <View style={[codeBlockStyle, shouldFill && styles.fillHeight]}>
            <DiffViewer
              diffLines={diffLines}
              maxHeight={resolvedMaxHeight}
              fillAvailableHeight={shouldFill}
            />
          </View>
        ) : null}
      </View>
    );
  } else if (detail?.type === "write") {
    sections.push(
      <View
        key="write"
        style={[styles.section, shouldFill && styles.fillHeight]}
      >
        {detail.content ? (
          <ScrollView
            style={[
              styles.scrollArea,
              resolvedMaxHeight !== undefined && { maxHeight: resolvedMaxHeight },
              shouldFill && styles.fillHeight,
            ]}
            contentContainerStyle={styles.scrollContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator={true}
          >
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator={true}
            >
              <Text selectable style={styles.scrollText}>{detail.content}</Text>
            </ScrollView>
          </ScrollView>
        ) : null}
      </View>
    );
  } else if (detail?.type === "read") {
    if (detail.content) {
      sections.push(
        <View
          key="read"
          style={[styles.section, shouldFill && styles.fillHeight]}
        >
          <ScrollView
            style={[
              styles.scrollArea,
              resolvedMaxHeight !== undefined && { maxHeight: resolvedMaxHeight },
              shouldFill && styles.fillHeight,
            ]}
            contentContainerStyle={styles.scrollContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator={true}
          >
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator={true}
            >
              <Text selectable style={styles.scrollText}>{detail.content}</Text>
            </ScrollView>
          </ScrollView>
        </View>
      );
    }
  } else if (detail?.type === "search") {
    sections.push(
      <View key="search" style={styles.section}>
        <Text selectable style={styles.scrollText}>{detail.query}</Text>
      </View>
    );
  } else if (detail?.type === "unknown") {
    const plainInputText =
      typeof detail.input === "string" && detail.output === null
        ? detail.input
        : null;

    if (plainInputText !== null) {
      sections.push(
        <View key="unknown-plain-text" style={styles.plainTextSection}>
          <Text selectable style={styles.plainText}>{plainInputText}</Text>
        </View>
      );
    } else {
      const sectionsFromTopLevel = [
        { title: "Input", value: detail.input },
        { title: "Output", value: detail.output },
      ].filter((entry) => entry.value !== null && entry.value !== undefined);

      for (const section of sectionsFromTopLevel) {
        let value = "";
        try {
          value =
            typeof section.value === "string"
              ? section.value
              : JSON.stringify(section.value, null, 2);
        } catch {
          value = String(section.value);
        }
        if (!value.length) {
          continue;
        }
        sections.push(
          <View key={`${section.title}-header`} style={styles.groupHeader}>
            <Text style={styles.groupHeaderText}>{section.title}</Text>
          </View>
        );
        sections.push(
          <View key={`${section.title}-value`} style={styles.section}>
            <ScrollView
              horizontal
              nestedScrollEnabled
              style={styles.jsonScroll}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
            >
              <Text selectable style={styles.scrollText}>{value}</Text>
            </ScrollView>
          </View>
        );
      }
    }
  }

  // Always show errors if available
  if (errorText) {
    sections.push(
      <View key="error" style={styles.section}>
        <Text style={[styles.sectionTitle, styles.errorText]}>Error</Text>
        <ScrollView
          horizontal
          nestedScrollEnabled
          style={[styles.jsonScroll, styles.jsonScrollError]}
          contentContainerStyle={styles.jsonContent}
          showsHorizontalScrollIndicator={true}
        >
          <Text selectable style={[styles.scrollText, styles.errorText]}>
            {errorText}
          </Text>
        </ScrollView>
      </View>
    );
  }

  if (sections.length === 0) {
    return (
      <Text style={styles.emptyStateText}>No additional details available</Text>
    );
  }

  return (
    <View
      style={[
        isFullBleed ? styles.fullBleedContainer : styles.paddedContainer,
        shouldFill && styles.fillHeight,
      ]}
    >
      {sections}
    </View>
  );
}

// ---- Styles ----

const styles = StyleSheet.create((theme) => {
  const insets = getCodeInsets(theme);

  return {
    paddedContainer: {
      gap: theme.spacing[4],
      padding: 0,
    },
    fullBleedContainer: {
      gap: theme.spacing[2],
      padding: 0,
    },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  groupHeaderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
    section: {
      gap: theme.spacing[2],
    },
    fillHeight: {
      flex: 1,
      minHeight: 0,
    },
  plainTextSection: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  plainText: {
    fontFamily: Fonts.sans,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    lineHeight: 22,
    overflowWrap: "anywhere",
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  rangeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
    diffContainer: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      overflow: "hidden",
      backgroundColor: theme.colors.surface2,
    },
    fullBleedBlock: {
      borderWidth: 0,
      borderRadius: 0,
      overflow: "hidden",
      backgroundColor: theme.colors.surface1,
    },
  codeVerticalScroll: {},
  codeVerticalContent: {
    flexGrow: 1,
    paddingBottom: insets.extraBottom,
  },
  codeHorizontalContent: {
    paddingRight: insets.extraRight,
  },
  codeLine: {
    minWidth: "100%",
    paddingHorizontal: insets.padding,
    paddingVertical: insets.padding,
  },
  scrollArea: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  scrollContent: {
    padding: insets.padding,
  },
    scrollText: {
      fontFamily: Fonts.mono,
      fontSize: theme.fontSize.xs,
      color: theme.colors.foreground,
      lineHeight: 18,
    },
    shellPrompt: {
      color: theme.colors.foregroundMuted,
    },
    jsonScroll: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  jsonScrollError: {
    borderColor: theme.colors.destructive,
  },
  jsonContent: {
    padding: insets.padding,
  },
  errorText: {
    color: theme.colors.destructive,
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontStyle: "italic",
  },
  };
});
