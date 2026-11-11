import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Check, Copy } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { markdownCopyDataSet } from "@/assistant-selection-copy/markup";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ICON_SIZE } from "@/styles/theme";

const ThemedCopy = withUnistyles(Copy, mutedIconColorMapping);
const ThemedCheck = withUnistyles(Check, mutedIconColorMapping);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator, mutedIconColorMapping);

interface BlockCopyButtonProps {
  onCopy: () => Promise<boolean>;
  visible: boolean;
  label: string;
}

export const BlockCopyButton = memo(function BlockCopyButton({
  onCopy,
  visible,
  label,
}: BlockCopyButtonProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const [status, setStatus] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const [focused, setFocused] = useState(false);
  const pending = useRef(false);
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );
  const handlePress = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    if (resetRef.current) clearTimeout(resetRef.current);
    setStatus("pending");
    try {
      const copied = await onCopy();
      setStatus(copied ? "copied" : "idle");
      if (copied) resetRef.current = setTimeout(() => setStatus("idle"), 1500);
    } catch {
      setStatus("failed");
    } finally {
      pending.current = false;
    }
  }, [onCopy]);
  const shown = visible || focused || status === "failed" || status === "pending";
  let icon = <ThemedCopy size={ICON_SIZE.sm} />;
  if (status === "pending") {
    icon = <ThemedActivityIndicator size={ICON_SIZE.sm} />;
  } else if (status === "copied") {
    icon = <ThemedCheck size={ICON_SIZE.sm} />;
  }
  return (
    <View style={styles.wrapper} dataSet={markdownCopyDataSet.ignore} pointerEvents="box-none">
      <ToolbarButton
        compact={compact}
        label={status === "copied" ? t("message.actions.copied") : label}
        onPress={handlePress}
        onFocus={focus}
        onBlur={blur}
        disabled={status === "pending"}
        hitSlop={8}
        aria-busy={status === "pending"}
        pointerEvents={shown ? "auto" : "none"}
        style={shown ? styles.visible : styles.hidden}
      >
        {icon}
      </ToolbarButton>
      {status === "failed" ? (
        <View style={styles.error}>
          <Text accessibilityRole="alert" style={styles.errorText}>
            {t("message.actions.copyFailed")}
          </Text>
          <Button variant="outline" size="sm" onPress={handlePress}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    alignItems: "flex-end",
  },
  visible: { opacity: 1 },
  hidden: { opacity: 0 },
  error: {
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  errorText: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
