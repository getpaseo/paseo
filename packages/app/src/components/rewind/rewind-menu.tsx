import { memo, useCallback, type ReactElement } from "react";
import { View } from "react-native";
import { FileText, Layers, MessageSquare, Undo2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type RewindMenuItem,
  type RewindMode,
  useRewindCapabilities,
} from "./use-rewind-capabilities";
import type { AgentCapabilityFlags } from "@server/server/agent/agent-sdk-types";

export type { RewindMode };

interface RewindMenuProps {
  capabilities: AgentCapabilityFlags;
  onRewind: (mode: RewindMode) => void;
  testID?: string;
}

function iconForItem(item: RewindMenuItem): ReactElement {
  switch (item.mode) {
    case "conversation":
      return <MessageSquare size={14} color="#8a8f98" />;
    case "files":
      return <FileText size={14} color="#8a8f98" />;
    case "both":
      return <Layers size={14} color="#8a8f98" />;
  }
}

export const RewindMenu = memo(function RewindMenu({
  capabilities,
  onRewind,
  testID = "rewind-menu",
}: RewindMenuProps) {
  const items = useRewindCapabilities(capabilities);
  const handleSelect = useCallback((mode: RewindMode) => () => onRewind(mode), [onRewind]);

  if (items.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        accessibilityLabel="Rewind message"
        style={styles.trigger}
        testID={`${testID}-trigger`}
      >
        <View style={styles.iconFrame}>
          <Undo2 size={16} color="#8a8f98" />
        </View>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={240} testID={`${testID}-content`}>
        {items.map((item) => (
          <DropdownMenuItem
            key={item.mode}
            leading={iconForItem(item)}
            onSelect={handleSelect(item.mode)}
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
  },
  iconFrame: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
}));
