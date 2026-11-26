import { memo, useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Check, Copy } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { markdownCopyDataSet } from "@/assistant-selection-copy/markup";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { smallIconButtonChromeFrameSize } from "@/components/ui/icon-button-chrome";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import type { Theme } from "@/styles/theme";

const ThemedCopy = withUnistyles(Copy, mutedIconColorMapping);
const ThemedCheck = withUnistyles(Check, mutedIconColorMapping);

const COPIED_RESET_MS = 1500;

/** How far the copy glyph sits from the top and trailing edges of its block. */
export function blockCopyGlyphInset(theme: Theme): number {
  return theme.spacing[2] + theme.spacing[1];
}

interface BlockCopyButtonProps {
  /** Writes the block to the clipboard. Resolves false, or rejects, when nothing was written. */
  onCopy: () => Promise<boolean>;
  /** The block's own reveal state. Keyboard focus shows the button regardless. */
  visible: boolean;
  label: string;
}

/**
 * The copy control in the top trailing corner of a Markdown block. The block is its
 * positioned ancestor.
 */
export const BlockCopyButton = memo(function BlockCopyButton({
  onCopy,
  visible,
  label,
}: BlockCopyButtonProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const compact = useIsCompactFormFactor();
  const [copied, setCopied] = useState(false);
  const [focused, setFocused] = useState(false);
  const writing = useRef(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const handlePress = useCallback(async () => {
    // A slow clipboard must not queue a second write behind the first.
    if (writing.current) return;
    writing.current = true;
    const written = await onCopy()
      .catch(() => false)
      .finally(() => {
        writing.current = false;
      });
    if (!written) {
      toast.error(t("common.errors.unableToCopy"));
      return;
    }
    setCopied(true);
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [onCopy, t, toast]);

  const shown = visible || focused;
  const Glyph = copied ? ThemedCheck : ThemedCopy;
  return (
    <View style={styles.corner(compact)} dataSet={markdownCopyDataSet.ignore}>
      <ToolbarButton
        compact={compact}
        label={copied ? t("message.actions.copied") : label}
        onPress={handlePress}
        onFocus={focus}
        onBlur={blur}
        style={shown ? styles.shown : styles.hidden}
      >
        <Glyph size={paneContentToolbarIconSize(compact)} />
      </ToolbarButton>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The glyph, not the button frame, sits on the inset; the frame overhangs it.
  corner: (compact: boolean) => {
    const frameOverhang =
      (smallIconButtonChromeFrameSize(compact) - paneContentToolbarIconSize(compact)) / 2;
    const inset = blockCopyGlyphInset(theme) - frameOverhang;
    return {
      position: "absolute" as const,
      top: inset,
      right: inset,
      pointerEvents: "box-none" as const,
    };
  },
  shown: { opacity: 1, pointerEvents: "auto" },
  hidden: { opacity: 0, pointerEvents: "none" },
}));
