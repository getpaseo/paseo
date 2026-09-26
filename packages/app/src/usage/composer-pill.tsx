import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import {
  isToolbarLabelTriggerHighlighted,
  toolbarLabelTriggerStyle,
  toolbarLabelTriggerTextStyle,
} from "@/components/ui/toolbar-label-trigger";
import { UsageCard } from "./card";
import { usageCopy } from "./copy";
import type { UsagePill } from "./model";
import { useAgentUsage } from "./queries";
import { UsageSourceIcon } from "./source-icon";

function pillTriggerStyle(state: MenuTriggerState) {
  return [toolbarLabelTriggerStyle(state), styles.trigger];
}

/** The agent's plan usage beside the composer controls. Opens the usage card. */
export function UsageComposerPill({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { pill, entry, refresh } = useAgentUsage(serverId, agentId);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) refresh();
    },
    [refresh],
  );

  if (!pill || !entry) return null;

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        style={pillTriggerStyle}
        accessibilityRole="button"
        accessibilityLabel={`${pill.sourceLabel} ${usageCopy.planUsage}`}
        testID="usage-composer-pill"
      >
        {(state) => (
          <UsagePillContent pill={pill} highlighted={isToolbarLabelTriggerHighlighted(state)} />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        offset={8}
        width={300}
        testID="usage-composer-popover"
        sheetTitle={usageCopy.planUsage}
      >
        <View style={styles.popover}>
          <UsageCard entry={entry} compact />
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UsagePillContent({ pill, highlighted }: { pill: UsagePill; highlighted: boolean }) {
  return (
    <>
      <UsageSourceIcon svg={pill.icon} size={14} />
      {pill.text ? (
        <Text style={toolbarLabelTriggerTextStyle(highlighted)} numberOfLines={1}>
          {pill.text}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    flexShrink: 0,
  },
  popover: {
    padding: theme.spacing[3],
  },
}));
