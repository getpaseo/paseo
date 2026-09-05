import React, { memo, useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { Check, Copy, X } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";

interface TextAttachmentModalProps {
  visible: boolean;
  title?: string;
  text: string | null;
  onClose: () => void;
}

const ThemedX = withUnistyles(X);
const ThemedCopy = withUnistyles(Copy);
const ThemedCheck = withUnistyles(Check);

const iconForegroundMuted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconForegroundSuccess = (theme: Theme) => ({ color: theme.colors.foregroundSuccess });

interface ModalHeaderProps {
  title?: string;
  lineCount: number;
  charCount: number;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}

function ModalHeader({ title, lineCount, charCount, copied, onCopy, onClose }: ModalHeaderProps) {
  return (
    <View style={styles.header}>
      <View style={styles.headerTitleColumn}>
        <Text style={styles.title} numberOfLines={1}>
          {title ?? "Pasted text"}
        </Text>
        <Text style={styles.meta}>
          {lineCount} {lineCount === 1 ? "line" : "lines"} • {charCount} chars
        </Text>
      </View>
      <View style={styles.headerActions}>
        <Button variant="ghost" size="sm" onPress={onCopy} style={styles.copyButton}>
          {copied ? (
            <ThemedCheck size={14} uniProps={iconForegroundSuccess} />
          ) : (
            <ThemedCopy size={14} uniProps={iconForegroundMuted} />
          )}
          <Text style={styles.copyButtonText}>{copied ? "Copied" : "Copy"}</Text>
        </Button>
        <Pressable
          testID="text-attachment-modal-close"
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}
          onPress={onClose}
          style={styles.closeButton}
        >
          <ThemedX size={18} uniProps={iconForegroundMuted} />
        </Pressable>
      </View>
    </View>
  );
}

export const TextAttachmentModal = memo(function TextAttachmentModal({
  visible,
  title,
  text,
  onClose,
}: TextAttachmentModalProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isWeb || !visible || typeof window === "undefined") return;
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [visible, onClose]);

  const handleCopy = useCallback(() => {
    if (!text) return;
    void Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  if (!visible || text === null) {
    return null;
  }

  const lineCount = text.split("\n").length;
  const charCount = text.length;

  return (
    <Modal
      transparent
      animationType="fade"
      statusBarTranslucent
      visible={visible}
      onRequestClose={onClose}
    >
      <WindowChromeRootRegion corners="both">
        <View style={styles.root}>
          <Pressable
            testID="text-attachment-modal-backdrop"
            accessibilityRole="button"
            accessibilityLabel="Close modal"
            onPress={onClose}
            style={styles.backdrop}
          />
          <View style={styles.cardContainer}>
            <View style={styles.card}>
              <ModalHeader
                title={title}
                lineCount={lineCount}
                charCount={charCount}
                copied={copied}
                onCopy={handleCopy}
                onClose={onClose}
              />
              <ScrollView
                style={styles.contentScrollView}
                contentContainerStyle={styles.contentContainer}
              >
                <Text selectable style={styles.codeText}>
                  {text}
                </Text>
              </ScrollView>
            </View>
          </View>
        </View>
      </WindowChromeRootRegion>
    </Modal>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[4],
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  cardContainer: {
    width: "100%",
    maxWidth: 800,
    maxHeight: "85%",
    zIndex: 1,
  },
  card: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
    flexDirection: "column",
    maxHeight: "100%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface1,
  },
  headerTitleColumn: {
    flex: 1,
    marginRight: theme.spacing[3],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  meta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  copyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    height: 28,
  },
  copyButtonText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  closeButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  contentScrollView: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    padding: theme.spacing[4],
  },
  codeText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 20,
  },
}));
