import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Split } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";

export type AssistantForkTarget = "tab" | "workspace";

interface AssistantForkMenuProps {
  onFork: (target: AssistantForkTarget) => Promise<void> | void;
  testID?: string;
}

const ThemedSplit = withUnistyles(Split);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const AssistantForkMenu = memo(function AssistantForkMenu({
  onFork,
  testID = "assistant-fork-menu",
}: AssistantForkMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<AssistantForkTarget | null>(null);
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
      setPendingTarget(target);
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

  const forkIcon = useMemo(() => <ThemedSplit size={16} uniProps={foregroundColorMapping} />, []);

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
                  size={16}
                  uniProps={hovered || open ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
      <DropdownMenuContent align="start" minWidth={220} side="bottom" testID={`${testID}-content`}>
        <DropdownMenuItem
          closeOnSelect={false}
          disabled={isLocked && pendingTarget !== "tab"}
          leading={forkIcon}
          onSelect={handleSelect("tab")}
          status={pendingTarget === "tab" ? "pending" : undefined}
          testID={`${testID}-new-tab`}
        >
          {t("message.actions.forkInNewTab")}
        </DropdownMenuItem>
        <DropdownMenuItem
          closeOnSelect={false}
          disabled={isLocked && pendingTarget !== "workspace"}
          leading={forkIcon}
          onSelect={handleSelect("workspace")}
          status={pendingTarget === "workspace" ? "pending" : undefined}
          testID={`${testID}-new-workspace`}
        >
          {t("message.actions.forkInNewWorkspace")}
        </DropdownMenuItem>
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
    fontSize: theme.fontSize.xs,
  },
}));
