import { useCallback } from "react";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { formatAgentModeLabel } from "@/agent-controls/labels";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function PlanAcceptModeMenuItem({
  mode,
  selected,
  testIdPrefix,
  onSelect,
}: {
  mode: AgentMode;
  selected: boolean;
  testIdPrefix: string;
  onSelect: (modeId: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(mode.id), [onSelect, mode.id]);
  return (
    <DropdownMenuItem
      testID={`${testIdPrefix}-${mode.id}`}
      selected={selected}
      showSelectedCheck
      onSelect={handleSelect}
    >
      {formatAgentModeLabel(mode)}
    </DropdownMenuItem>
  );
}
