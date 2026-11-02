import { useCallback } from "react";
import { AgentSkillsRow } from "@/agent-skills";
import { SettingsCard } from "@/components/settings";
import { CommandLineRow } from "@/desktop/components/integrations-section";
import { PaseoToolsRow } from "@/screens/settings/paseo-tools-card";
import type { OrchestrationSetupController } from "../orchestration-setup";

/** Three switches, all on to start; Continue applies them. */
export function OrchestrationStep({ setup }: { setup: OrchestrationSetupController }) {
  const { choices, setChoice, offered, isApplying } = setup;
  const setTools = useCallback((on: boolean) => setChoice("tools", on), [setChoice]);
  const setSkills = useCallback((on: boolean) => setChoice("skills", on), [setChoice]);
  const setCli = useCallback((on: boolean) => setChoice("cli", on), [setChoice]);
  return (
    <SettingsCard>
      <PaseoToolsRow value={choices.tools} onValueChange={setTools} disabled={isApplying} />
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
