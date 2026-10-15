import React, { useCallback, useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { ResponseFoldHeader } from "./response-folding";

export function ResponseFoldToggle({
  header,
  onToggle,
}: {
  header: ResponseFoldHeader;
  onToggle: (responseId: string) => void;
}) {
  const { t } = useTranslation();
  const accessibilityState = useMemo(() => ({ expanded: header.expanded }), [header.expanded]);
  const handlePress = useCallback(() => onToggle(header.responseId), [onToggle, header.responseId]);
  return (
    <Button
      variant="ghost"
      size="sm"
      style={styles.button}
      leftIcon={header.expanded ? ChevronDown : ChevronRight}
      accessibilityState={accessibilityState}
      aria-expanded={header.expanded}
      onPress={handlePress}
      testID="response-fold-toggle"
    >
      {t("agentStream.foldedMessages", { count: header.count })}
    </Button>
  );
}

const styles = StyleSheet.create(() => ({
  button: {
    justifyContent: "flex-start",
    paddingHorizontal: 0,
  },
}));
