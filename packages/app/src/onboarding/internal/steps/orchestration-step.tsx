import { useCallback } from "react";
import { AgentSkillsRow } from "@/agent-skills";
import { SettingsCard } from "@/components/settings";
import { CommandLineRow } from "@/desktop/components/integrations-section";
import { AgentToolsRow } from "@/screens/settings/agent-tools-row";
import type { OrchestrationSetupController } from "../orchestration-setup";

/** Three switches, all on to start; Continue applies them. */
export function OrchestrationStep({ setup }: { setup: OrchestrationSetupController }) {
  const { choices, toolGroups, supportsToolGroups, setChoice, setToolGroup, offered, isApplying } =
    setup;
  const setTools = useCallback((on: boolean) => setChoice("tools", on), [setChoice]);
  const setSkills = useCallback((on: boolean) => setChoice("skills", on), [setChoice]);
  const setCli = useCallback((on: boolean) => setChoice("cli", on), [setChoice]);
  return (
    <SettingsCard>
      <AgentToolsRow
        enabled={choices.tools}
        groups={toolGroups}
        supportsGroupControls={supportsToolGroups}
        onEnabledChange={setTools}
        onGroupChange={setToolGroup}
        disabled={isApplying}
      />
      {offered.skills ? (
        <AgentSkillsRow
          skills={setup.skills}
          value={choices.skills}
          onValueChange={setSkills}
          disabled={isApplying}
        />
      ) : null}
      {offered.cli ? (
        <CommandLineRow value={choices.cli} onValueChange={setCli} disabled={isApplying} />
      ) : null}
    </SettingsCard>
  );
}
