import { useCallback, useState } from "react";
import { areSkillsInstalled, useAgentSkills, type AgentSkillsController } from "@/agent-skills";
import { useCliInstall } from "@/desktop/hooks/use-install-status";
import { useDaemonConfig } from "@/hooks/use-daemon-config";

export type OrchestrationChoice = "tools" | "skills" | "cli";
type Choices = Record<OrchestrationChoice, boolean>;

const ALL_ON: Choices = { tools: true, skills: true, cli: true };

export interface OrchestrationSetupController {
  choices: Choices;
  setChoice: (choice: OrchestrationChoice, on: boolean) => void;
  /** Only the choices this host and app can act on: skills need host support, the CLI the desktop app. */
  offered: Choices;
  /** The skills row's picker and Update act on the host directly, through this. */
  skills: AgentSkillsController;
  isApplying: boolean;
  /** Brings the host in line with the choices; resolves true only when every one took. */
  apply: () => Promise<boolean>;
}

/**
 * The Orchestration step's choices. Everything starts on and nothing touches the host or this
 * computer until Continue applies them, the way checked projects are added.
 */
export function useOrchestrationSetup(serverId: string): OrchestrationSetupController {
  const skills = useAgentSkills(serverId);
  const cli = useCliInstall();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [choices, setChoices] = useState<Choices>(ALL_ON);
  const [isApplying, setIsApplying] = useState(false);
  const offered: Choices = {
    tools: true,
    skills: skills.connected && skills.supported,
    cli: cli.available,
  };

  const setChoice = useCallback((choice: OrchestrationChoice, on: boolean) => {
    setChoices((current) => ({ ...current, [choice]: on }));
  }, []);

  const toolsOn = config?.mcp.injectIntoAgents !== false;
  const skillsInstalled = areSkillsInstalled(skills.status);
  const cliInstalled = cli.status?.installed ?? false;
  const { reconcile, uninstall } = skills;
  const { setInstalled: setCliInstalled } = cli;
  const offersSkills = offered.skills;
  const offersCli = offered.cli;

  const setSkillsInstalled = useCallback(
    () => (choices.skills ? reconcile() : uninstall()),
    [choices.skills, reconcile, uninstall],
  );

  const apply = useCallback(async () => {
    setIsApplying(true);
    try {
      const results = await Promise.all([
        choices.tools === toolsOn
          ? true
          : patchConfig({ mcp: { injectIntoAgents: choices.tools } }).then(Boolean, () => false),
        !offersSkills || choices.skills === skillsInstalled ? true : setSkillsInstalled(),
        !offersCli || choices.cli === cliInstalled ? true : setCliInstalled(choices.cli),
      ]);
      return results.every(Boolean);
    } finally {
      setIsApplying(false);
    }
  }, [
    choices,
    toolsOn,
    patchConfig,
    offersSkills,
    skillsInstalled,
    setSkillsInstalled,
    offersCli,
    cliInstalled,
    setCliInstalled,
  ]);

  return { choices, setChoice, offered, skills, isApplying, apply };
}
