import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { FileText, Layers, MessageSquare, Undo2 } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type RewindMode, useRewindCapabilities } from "./use-rewind-capabilities";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";

export type { RewindMode };

interface RewindMenuProps {
  capabilities: AgentCapabilityFlags;
  rewoundText: string;
  onRewind: (input: { mode: RewindMode; rewoundText: string }) => Promise<void> | void;
  isPending?: boolean;
  testID?: string;
}

function getIcon(mode: RewindMode, color: string): ReactElement {
  switch (mode) {
    case "conversation":
      return <MessageSquare size={16} color={color} />;
    case "files":
      return <FileText size={16} color={color} />;
    case "both":
      return <Layers size={16} color={color} />;
  }
}

export const RewindMenu = memo(function RewindMenu({
  capabilities,
  rewoundText,
  onRewind,
  isPending: isPendingProp = false,
  testID = "rewind-menu",
}: RewindMenuProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const rewindLabels = useMemo(
    () => ({
      conversation: t("rewind.actions.conversation"),
      files: t("rewind.actions.files"),
      both: t("rewind.actions.both"),
    }),
    [t],
  );
  const items = useRewindCapabilities(capabilities, rewindLabels);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<RewindMode | null>(null);
  const isLocked = isPendingProp || pendingMode !== null;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && pendingMode !== null) return;
      setIsOpen(next);
    },
    [pendingMode],
  );

  const handleSelect = useCallback(
    (mode: RewindMode) => async () => {
      if (isLocked) return;
      setPendingMode(mode);
      try {
        await onRewind({ mode, rewoundText });
      } catch {
        // useRewindAgentMutation owns the toast; the menu only owns flow state.
      } finally {
        setPendingMode(null);
        setIsOpen(false);
      }
    },
    [isLocked, onRewind, rewoundText],
  );

  const triggerStyle = useCallback(
    () => [styles.trigger, isLocked ? styles.triggerDisabled : null],
    [isLocked],
  );

  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("rewind.tooltip")}</Text>
      </TooltipContent>
    ),
    [t],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <View style={styles.triggerSlot} collapsable={false}>
            <DropdownMenuTrigger
              accessibilityLabel={t("rewind.tooltip")}
              accessibilityRole="button"
              disabled={isLocked}
              style={triggerStyle}
              testID={`${testID}-trigger`}
            >
              {({ hovered, open }) => (
                <Undo2
                  size={16}
                  color={hovered || open ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
      <DropdownMenuContent align="end" minWidth={220} side="bottom" testID={`${testID}-content`}>
        <View style={styles.warningHeader}>
          <Text style={styles.warningText}>{t("rewind.warning")}</Text>
        </View>
        <DropdownMenuSeparator />
        {items.map((item) => (
          <DropdownMenuItem
            key={item.mode}
            closeOnSelect={false}
            disabled={isLocked && pendingMode !== item.mode}
            leading={getIcon(item.mode, theme.colors.foreground)}
            onSelect={handleSelect(item.mode)}
            status={pendingMode === item.mode ? "pending" : undefined}
            testID={item.testID}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    paddingTop: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  triggerSlot: {
    alignSelf: "center",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  warningHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  warningText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
