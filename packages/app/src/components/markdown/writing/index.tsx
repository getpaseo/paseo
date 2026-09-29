import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "@/components/icons/ui-icons";
import { useTranslation } from "react-i18next";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { markdownCopyDataSet, TRAILING_CODE_LINE_BREAKS } from "@/assistant-selection-copy/markup";
import type { MarkdownFenceRendererProps } from "../fence/types";
import { parseWritingFenceInfo } from "./info";

interface WritingFenceProps extends MarkdownFenceRendererProps {
  info: string | null | undefined;
}

const COPIED_RESET_MS = 1500;
const WEB_SELECTABLE: TextStyle = isWeb ? ({ userSelect: "text" } as TextStyle) : {};

/**
 * The body is rendered verbatim rather than re-parsed as markdown. A writing
 * block is text the user pastes somewhere else unchanged, so `**fett**` in a
 * WhatsApp draft has to survive as asterisks — and what is on screen stays
 * exactly what the copy button puts on the clipboard.
 */
export function WritingFence({ code, info, inheritedStyles }: WritingFenceProps) {
  const { t } = useTranslation();
  const parsed = parseWritingFenceInfo(info);
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const controlsVisible = isHovered || isNative || isCompact;

  const body = useMemo(() => code.replace(TRAILING_CODE_LINE_BREAKS, ""), [code]);
  const getBody = useCallback(() => body, [body]);

  // Drop the monospace family the fence style carries; keep the size and colour
  // of the surrounding prose so the card reads as text, not as code.
  const bodyStyle = useMemo(() => {
    const { fontFamily: _fontFamily, ...prose } = inheritedStyles;
    const fontSize = prose.fontSize;
    return [
      styles.body,
      prose,
      WEB_SELECTABLE,
      fontSize !== undefined ? { lineHeight: Math.round(fontSize * 1.5) } : null,
    ];
  }, [inheritedStyles]);

  return (
    <View
      style={styles.container}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <View style={styles.header} dataSet={markdownCopyDataSet.ignore}>
        <Text style={styles.title} numberOfLines={1}>
          {parsed?.title ?? t("message.writingBlock.untitled")}
        </Text>
        <CopyButton getBody={getBody} visible={controlsVisible} />
      </View>
      <Text style={bodyStyle}>{body}</Text>
    </View>
  );
}

interface CopyButtonProps {
  getBody: () => string;
  visible: boolean;
}

const CopyButton = React.memo(function CopyButton({ getBody, visible }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const handlePress = useCallback(async () => {
    const content = getBody();
    if (!content) return;
    await Clipboard.setStringAsync(content);
    setCopied(true);
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => {
      setCopied(false);
      resetRef.current = null;
    }, COPIED_RESET_MS);
  }, [getBody]);

  const wrapperStyle = useMemo(
    () => [styles.copyButton, visible ? styles.copyButtonVisible : styles.copyButtonHidden],
    [visible],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={wrapperStyle}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityRole="button"
      accessibilityLabel={copied ? t("message.actions.copied") : t("message.actions.copyText")}
      hitSlop={8}
      dataSet={markdownCopyDataSet.ignore}
    >
      {({ hovered }) => {
        const iconColor = hovered ? styles.iconHoveredColor.color : styles.iconColor.color;
        return copied ? (
          <Check size={14} color={iconColor} />
        ) : (
          <Copy size={14} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingTop: theme.spacing[1],
  },
  title: {
    flexShrink: 1,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  body: {
    color: theme.colors.foreground,
  },
  copyButton: {
    padding: theme.spacing[1],
    marginRight: -theme.spacing[1],
  },
  copyButtonVisible: {
    opacity: 1,
  },
  copyButtonHidden: {
    opacity: 0,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));
