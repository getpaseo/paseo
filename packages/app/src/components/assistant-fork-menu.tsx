import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Split } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE, type Theme } from "@/styles/theme";

/**
 * `branch` copies the provider's own session up to the turn, so the fork keeps the reasoning,
 * tool results and compaction summaries the agent worked from. `history` starts a new agent from
 * a chat-history attachment, which works on any provider.
 */
export type AssistantForkKind = "branch" | "history";
export type AssistantForkDestination = "tab" | "workspace";
export interface AssistantForkTarget {
  kind: AssistantForkKind;
  destination: AssistantForkDestination;
}

interface AssistantForkMenuProps {
  onFork: (target: AssistantForkTarget) => Promise<void> | void;
  /** Why `branch` cannot run for this turn; null when it can. */
  branchUnavailableReason: string | null;
  testID?: string;
}

function targetKey(target: AssistantForkTarget): string {
  return `${target.kind}:${target.destination}`;
}

const ThemedSplit = withUnistyles(Split);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const AssistantForkMenu = memo(function AssistantForkMenu({
  onFork,
  branchUnavailableReason,
  testID = "assistant-fork-menu",
}: AssistantForkMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const isLocked = pendingTarget !== null;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && pendingTarget !== null) return;
      setIsOpen(next);
    },
    [pendingTarget],
  );

  const handleSelect = useCallback(
    (target: AssistantForkTarget) => async () => {
      if (isLocked) return;
      setPendingTarget(targetKey(target));
      try {
        await onFork(target);
      } finally {
        setPendingTarget(null);
        setIsOpen(false);
      }
    },
    [isLocked, onFork],
  );

  const triggerStyle = useCallback(
    () => [styles.trigger, isLocked ? styles.triggerDisabled : null],
    [isLocked],
  );

  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("message.actions.forkMenu")}</Text>
      </TooltipContent>
    ),
    [t],
  );

  const forkIcon = useMemo(
    () => <ThemedSplit size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />,
    [],
  );

  function renderItem(target: AssistantForkTarget, itemTestID: string) {
    const key = targetKey(target);
    const unavailableReason = target.kind === "branch" ? branchUnavailableReason : null;
    return (
      <DropdownMenuItem
        closeOnSelect={false}
        description={unavailableReason ?? undefined}
        disabled={unavailableReason !== null || (isLocked && pendingTarget !== key)}
        leading={forkIcon}
        onSelect={handleSelect(target)}
        status={pendingTarget === key ? "pending" : undefined}
        testID={itemTestID}
      >
        {target.destination === "tab"
          ? t("message.actions.forkNewTab")
          : t("message.actions.forkNewWorkspace")}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <View style={styles.triggerSlot} collapsable={false}>
            <DropdownMenuTrigger
              accessibilityLabel={t("message.actions.forkMenu")}
              accessibilityRole="button"
              disabled={isLocked}
              style={triggerStyle}
              testID={`${testID}-trigger`}
            >
              {({ hovered, open }) => (
                <ThemedSplit
                  size={ICON_SIZE.sm}
                  uniProps={hovered || open ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
      <DropdownMenuContent align="start" minWidth={240} side="bottom" testID={`${testID}-content`}>
        <DropdownMenuLabel>{t("message.actions.forkBranchSession")}</DropdownMenuLabel>
        {renderItem({ kind: "branch", destination: "tab" }, `${testID}-branch-new-tab`)}
        {renderItem({ kind: "branch", destination: "workspace" }, `${testID}-branch-new-workspace`)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("message.actions.forkCopyChatHistory")}</DropdownMenuLabel>
        {renderItem({ kind: "history", destination: "tab" }, `${testID}-new-tab`)}
        {renderItem({ kind: "history", destination: "workspace" }, `${testID}-new-workspace`)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
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
    fontSize: theme.fontSize.sm,
  },
}));
