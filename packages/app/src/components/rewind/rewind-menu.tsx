import { memo, useCallback, useMemo, useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import { FileText, Layers, MessageSquare, Undo2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type RewindMenuItem,
  type RewindMode,
  useRewindCapabilities,
} from "./use-rewind-capabilities";
import type { AgentCapabilityFlags } from "@server/server/agent/agent-sdk-types";

export type { RewindMode };

interface RewindMenuProps {
  capabilities: AgentCapabilityFlags;
  rewoundText: string;
  onRewind: (input: { mode: RewindMode; rewoundText: string }) => Promise<void> | void;
  isPending?: boolean;
  testID?: string;
}

const REWIND_HEADER: SheetHeader = { title: "Rewind to this message" };
const SNAP_POINTS: string[] = ["42%", "72%"];

function iconForItem(item: RewindMenuItem): ComponentType<{ color: string; size: number }> {
  switch (item.mode) {
    case "conversation":
      return MessageSquare;
    case "files":
      return FileText;
    case "both":
      return Layers;
  }
}

export const RewindMenu = memo(function RewindMenu({
  capabilities,
  rewoundText,
  onRewind,
  isPending = false,
  testID = "rewind-menu",
}: RewindMenuProps) {
  const items = useRewindCapabilities(capabilities);
  const [isSheetVisible, setIsSheetVisible] = useState(false);
  const [pendingMode, setPendingMode] = useState<RewindMode | null>(null);
  const handleOpen = useCallback(() => setIsSheetVisible(true), []);
  const handleClose = useCallback(() => {
    if (!isPending) {
      setIsSheetVisible(false);
    }
  }, [isPending]);
  const handleSelect = useCallback(
    (mode: RewindMode) => async () => {
      if (isPending) {
        return;
      }
      setPendingMode(mode);
      try {
        await onRewind({ mode, rewoundText });
      } catch {
        // useRewindAgentMutation owns the toast; the sheet only owns flow state.
      } finally {
        setPendingMode(null);
        setIsSheetVisible(false);
      }
    },
    [isPending, onRewind, rewoundText],
  );
  const triggerIcon = useCallback((color: string) => <Undo2 size={16} color={color} />, []);
  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>Rewind to this message</Text>
      </TooltipContent>
    ),
    [],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <Button
            accessibilityLabel="Rewind to this message"
            disabled={isPending}
            leftIcon={triggerIcon}
            onPress={handleOpen}
            size="xs"
            style={styles.trigger}
            testID={`${testID}-trigger`}
            variant="ghost"
          />
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
      <AdaptiveModalSheet
        desktopMaxWidth={420}
        header={REWIND_HEADER}
        onClose={handleClose}
        scrollable={false}
        snapPoints={SNAP_POINTS}
        testID={`${testID}-content`}
        visible={isSheetVisible}
      >
        <View style={styles.content}>
          <Text style={styles.warningText}>This action cannot be undone</Text>
          <View style={styles.actions}>
            {items.map((item) => (
              <Button
                key={item.mode}
                leftIcon={iconForItem(item)}
                loading={pendingMode === item.mode}
                disabled={isPending}
                onPress={handleSelect(item.mode)}
                size="md"
                style={styles.actionButton}
                testID={item.testID}
                variant="secondary"
              >
                {item.label}
              </Button>
            ))}
          </View>
        </View>
      </AdaptiveModalSheet>
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 24,
    height: 24,
    minHeight: 24,
    paddingHorizontal: 0,
    paddingVertical: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  content: {
    gap: theme.spacing[4],
  },
  warningText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    gap: theme.spacing[2],
  },
  actionButton: {
    justifyContent: "flex-start",
  },
}));
