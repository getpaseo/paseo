import { useCallback, useMemo } from "react";
import { type PressableStateCallbackType } from "react-native";
import { Archive, MoreVertical, Pin, PinOff } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { Theme } from "@/styles/theme";
import { useHostFeature } from "@/runtime/host-features";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ThemedArchive = withUnistyles(Archive);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const archiveIcon = <ThemedArchive size={14} uniProps={mutedColorMapping} />;
const pinIcon = <ThemedPin size={14} uniProps={mutedColorMapping} />;
const pinOffIcon = <ThemedPinOff size={14} uniProps={mutedColorMapping} />;

export function HistoryAgentActionMenu({
  agent,
  pending,
  onTogglePin,
  onArchive,
}: {
  agent: AggregatedAgent;
  pending: boolean;
  onTogglePin: (agent: AggregatedAgent) => void;
  onArchive: (agent: AggregatedAgent) => void;
}) {
  const supportsPinning = useHostFeature(agent.serverId, "agentPinning");
  const isPinned = Boolean(agent.pinnedAt);
  const handleTogglePin = useCallback(() => onTogglePin(agent), [agent, onTogglePin]);
  const handleArchive = useCallback(() => onArchive(agent), [agent, onArchive]);
  const selectedPinIcon = useMemo(() => (isPinned ? pinOffIcon : pinIcon), [isPinned]);
  let pinLabel = "Update host to pin sessions";
  if (supportsPinning) pinLabel = isPinned ? "Unpin session" : "Pin session";
  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      pressed && styles.triggerPressed,
    ],
    [],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${agent.title || "session"}`}
        testID={`history-agent-actions-${agent.serverId}-${agent.id}`}
      >
        <ThemedMoreVertical size={16} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={240}>
        <DropdownMenuItem
          leading={selectedPinIcon}
          disabled={!supportsPinning || pending}
          status={pending ? "pending" : "idle"}
          pendingLabel={isPinned ? "Unpinning..." : "Pinning..."}
          onSelect={handleTogglePin}
        >
          {pinLabel}
        </DropdownMenuItem>
        {!agent.archivedAt ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem leading={archiveIcon} disabled={pending} onSelect={handleArchive}>
              Archive session
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
