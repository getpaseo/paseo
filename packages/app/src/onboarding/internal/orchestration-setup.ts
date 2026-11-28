import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  areSkillsInstalled,
  hasSelectedSkills,
  useAgentSkills,
  type AgentSkillsController,
} from "@/agent-skills";
import { useToast } from "@/contexts/toast-context";
import { useCliInstall } from "@/desktop/hooks/use-install-status";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import {
  createOnboardingAgentToolsPatch,
  DEFAULT_AGENT_TOOL_GROUPS,
  resolveAgentToolsState,
  type AgentToolGroupId,
  type AgentToolGroupsState,
} from "@/screens/settings/agent-tools-config";

export type OrchestrationChoice = "tools" | "skills" | "cli";
type Choices = Record<OrchestrationChoice, boolean>;

const ALL_ON: Choices = { tools: true, skills: true, cli: true };

export interface OrchestrationSetupController {
  choices: Choices;
  toolGroups: AgentToolGroupsState;
  supportsToolGroups: boolean;
  setChoice: (choice: OrchestrationChoice, on: boolean) => void;
  setToolGroup: (group: AgentToolGroupId, on: boolean) => void;
  /** Only the choices this host and app can act on: skills need host support, the CLI the desktop app. */
  offered: Choices;
  /** The skills row's picker and Update act on the host directly, through this. */
  skills: AgentSkillsController;
  isApplying: boolean;
  /**
   * Brings the host in line with the choices; resolves true only when every one took. Each failure
   * is shown to the user.
   */
  apply: () => Promise<boolean>;
}

/**
 * The Orchestration step's choices. Everything starts on and nothing touches the host or this
 * computer until Continue applies them, the way checked projects are added.
 */
export function useOrchestrationSetup(serverId: string): OrchestrationSetupController {
  const { t } = useTranslation();
  const toast = useToast();
  const skills = useAgentSkills(serverId);
  const cli = useCliInstall();
  const supportsToolGroups = useHostFeature(serverId, "daemonToolsConfig");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [chosen, setChosen] = useState<Choices>(ALL_ON);
  const [changedToolGroups, setChangedToolGroups] = useState<Partial<AgentToolGroupsState>>({});
  // With nothing picked there is nothing to install, so skills read as off, as they do in Settings.
  const skillsSelected = skills.status === null || hasSelectedSkills(skills.status);
  const choices = useMemo<Choices>(
    () => ({ ...chosen, skills: chosen.skills && skillsSelected }),
    [chosen, skillsSelected],
  );
  const [isApplying, setIsApplying] = useState(false);
  const offered: Choices = {
    tools: true,
    skills: skills.connected && skills.supported,
    cli: cli.available,
  };

  const setChoice = useCallback((choice: OrchestrationChoice, on: boolean) => {
    setChosen((current) => ({ ...current, [choice]: on }));
  }, []);

  const setToolGroup = useCallback((group: AgentToolGroupId, on: boolean) => {
    setChangedToolGroups((current) => ({ ...current, [group]: on }));
  }, []);

  // What the host and this computer have now, or null while it is still being read. A choice is
  // skipped only when it is known to match; an unknown state is always written.
  const currentToolsState = useMemo(
    () =>
      config ? resolveAgentToolsState({ config, supportsToolsConfig: supportsToolGroups }) : null,
    [config, supportsToolGroups],
  );
  const toolGroups = useMemo<AgentToolGroupsState>(
    () => ({ ...(currentToolsState?.groups ?? DEFAULT_AGENT_TOOL_GROUPS), ...changedToolGroups }),
    [currentToolsState, changedToolGroups],
  );
  const skillsInstalled = skills.status ? areSkillsInstalled(skills.status) : null;
  const cliInstalled = cli.status ? cli.status.installed : null;
  const { reconcile, uninstall } = skills;
  const { setInstalled: setCliInstalled } = cli;
  const offersSkills = offered.skills;
  const offersCli = offered.cli;

  const applyTools = useCallback(() => {
    const patch = createOnboardingAgentToolsPatch({
      enabled: choices.tools,
      changedGroups: changedToolGroups,
      current: currentToolsState,
      supportsToolsConfig: supportsToolGroups,
    });
    if (!patch) return Promise.resolve(true);
    return patchConfig(patch)
      .then(Boolean, () => false)
      .then((done) => {
        if (!done) toast.error(t("settings.host.orchestration.enableTools.updateFailed"));
        return done;
      });
  }, [
    changedToolGroups,
    choices.tools,
    currentToolsState,
    patchConfig,
    supportsToolGroups,
    t,
    toast,
  ]);

  const setSkillsInstalled = useCallback(
    (on: boolean) => (on ? reconcile() : uninstall()),
    [reconcile, uninstall],
  );

  const apply = useCallback(async () => {
    setIsApplying(true);
    try {
      const results = await Promise.all([
        applyTools(),
        !offersSkills || choices.skills === skillsInstalled
          ? true
          : setSkillsInstalled(choices.skills),
        !offersCli || choices.cli === cliInstalled ? true : setCliInstalled(choices.cli),
      ]);
      return results.every(Boolean);
    } finally {
      setIsApplying(false);
    }
  }, [
    applyTools,
    choices.cli,
    choices.skills,
    skillsInstalled,
    setSkillsInstalled,
    offersSkills,
    offersCli,
    cliInstalled,
    setCliInstalled,
  ]);

  return {
    choices,
    toolGroups,
    supportsToolGroups,
    setChoice,
    setToolGroup,
    offered,
    skills,
    isApplying,
    apply,
  };
}
