import type {
  AgentFeature,
  AgentMode,
  AgentProvider,
  AgentSelectOption,
} from "@getpaseo/protocol/agent-types";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "@/composer/agent-controls/utils";
import { isPlanningAgentMode } from "@/composer/agent-controls/mode";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

const PLAN_MODE_FEATURE_ID = "plan_mode";
const FAST_MODE_FEATURE_ID = "fast_mode";

const GROUP_RANK = {
  models: 1,
  thinking: 1.1,
  modes: 1.2,
  planMode: 1.3,
  fastMode: 1.4,
} as const;

export interface AgentControlContributionLabels {
  model: string;
  thinking: string;
  mode: string;
  planMode: string;
  fast: string;
  on: string;
  off: string;
  modelKeywords: string;
  thinkingKeywords: string;
  modeKeywords: string;
  planKeywords: string;
  fastKeywords: string;
}

export function buildAgentControlContributionLabels(
  t: (key: string) => string,
): AgentControlContributionLabels {
  return {
    model: t("shell.commandCenter.modelGroupLabel"),
    thinking: t("shell.commandCenter.thinkingGroupLabel"),
    mode: t("shell.commandCenter.modeGroupLabel"),
    planMode: t("shell.commandCenter.planModeGroupLabel"),
    fast: t("shell.commandCenter.fastModeGroupLabel"),
    on: t("shell.commandCenter.settingOn"),
    off: t("shell.commandCenter.settingOff"),
    modelKeywords: t("shell.commandCenter.modelSearchKeywords"),
    thinkingKeywords: t("shell.commandCenter.thinkingSearchKeywords"),
    modeKeywords: t("shell.commandCenter.modeSearchKeywords"),
    planKeywords: t("shell.commandCenter.planModeSearchKeywords"),
    fastKeywords: t("shell.commandCenter.fastModeSearchKeywords"),
  };
}

export interface AgentControlContributionIcons {
  provider(provider: AgentProvider): CommandCenterIcon;
  thinking: CommandCenterIcon;
  planMode: CommandCenterIcon;
  mode(modeId: string): CommandCenterIcon;
  feature(feature: AgentFeature): CommandCenterIcon;
}

interface CommandCenterChoice {
  id: string;
  path: readonly string[];
  keywords?: readonly string[];
  icon?: CommandCenterIcon;
  selected: boolean;
  testId?: string;
  select(): void | Promise<void>;
}

interface CommandCenterChoiceGroup {
  id: string;
  rank: number;
  label: string;
  keywords: readonly string[];
  choices: readonly CommandCenterChoice[];
}

export interface AgentControlContributionSource {
  serverId: string;
  ownerKey: string;
  provider: string | null;
  labels: AgentControlContributionLabels;
  icons: AgentControlContributionIcons;
  models: {
    providers: readonly ProviderSelectorProvider[];
    selectedProvider: string | null;
    selectedModelId: string | null;
    select(provider: AgentProvider, modelId: string): void | Promise<void>;
  };
  thinking: {
    options: readonly AgentSelectOption[];
    selectedId: string | null;
    select(optionId: string): void | Promise<void>;
  };
  modes: {
    options: readonly AgentMode[];
    selectedId: string | null;
    defaultModeId: string | null;
    select(modeId: string): void | Promise<void>;
  };
  features: {
    list: readonly AgentFeature[];
    set(featureId: string, value: unknown): void | Promise<void>;
  };
}

function buildContributions(
  groups: readonly CommandCenterChoiceGroup[],
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [];
  for (const group of groups) {
    for (const [rank, choice] of group.choices.entries()) {
      contributions.push({
        id: `${group.id}:${choice.id}`,
        group: group.id,
        groupRank: group.rank,
        rank,
        keywords: [...group.keywords, ...(choice.keywords ?? [])],
        visibility: "query",
        run: () => {
          if (!choice.selected) return choice.select();
        },
        presentation: {
          kind: "choice",
          path: [group.label, ...choice.path],
          icon: choice.icon,
          selected: choice.selected,
          testId: choice.testId,
        },
      });
    }
  }
  return contributions;
}

function buildModelGroup(source: AgentControlContributionSource): CommandCenterChoiceGroup {
  const choices: CommandCenterChoice[] = [];
  for (const provider of source.models.providers) {
    if (provider.modelSelection.kind !== "models") continue;
    const agentProvider = provider.id;
    const icon = source.icons.provider(agentProvider);
    for (const model of provider.modelSelection.rows) {
      if (!model.modelId) continue;
      const modelId = model.modelId;
      choices.push({
        id: `${provider.id}:${modelId}`,
        path: [provider.label, model.modelLabel],
        keywords: [modelId],
        icon,
        selected:
          source.models.selectedProvider === provider.id &&
          source.models.selectedModelId === modelId,
        testId: `command-center-model-${source.serverId}:${provider.id}:${modelId}`,
        select: () => source.models.select(agentProvider, modelId),
      });
    }
  }
  return {
    id: "models",
    rank: GROUP_RANK.models,
    label: source.labels.model,
    keywords: [source.labels.modelKeywords],
    choices,
  };
}

function buildThinkingGroup(source: AgentControlContributionSource): CommandCenterChoiceGroup {
  const choices =
    source.thinking.options.length > 1
      ? source.thinking.options.map(
          (option): CommandCenterChoice => ({
            id: option.id,
            path: [formatThinkingOptionLabel(option)],
            icon: source.icons.thinking,
            selected: option.id === source.thinking.selectedId,
            testId: `command-center-thinking-${source.serverId}:${source.ownerKey}:${option.id}`,
            select: () => source.thinking.select(option.id),
          }),
        )
      : [];
  return {
    id: "thinking",
    rank: GROUP_RANK.thinking,
    label: source.labels.thinking,
    keywords: [source.labels.thinkingKeywords],
    choices,
  };
}

function buildModeGroup(source: AgentControlContributionSource): CommandCenterChoiceGroup {
  const choices = source.modes.options
    .filter((mode) => !isPlanningAgentMode(mode.id))
    .map(
      (mode): CommandCenterChoice => ({
        id: mode.id,
        path: [formatAgentModeLabel(mode)],
        icon: source.icons.mode(mode.id),
        selected: mode.id === source.modes.selectedId,
        testId: `command-center-mode-${source.serverId}:${source.ownerKey}:${mode.id}`,
        select: () => source.modes.select(mode.id),
      }),
    );
  return {
    id: "modes",
    rank: GROUP_RANK.modes,
    label: source.labels.mode,
    keywords: [source.labels.modeKeywords],
    choices,
  };
}

function toggleChoices(input: {
  source: AgentControlContributionSource;
  key: "plan" | "fast";
  icon: CommandCenterIcon;
  isOn: boolean;
  turnOn(): void | Promise<void>;
  turnOff(): void | Promise<void>;
}): CommandCenterChoice[] {
  const states = [
    { id: "on", label: input.source.labels.on, selected: input.isOn, select: input.turnOn },
    { id: "off", label: input.source.labels.off, selected: !input.isOn, select: input.turnOff },
  ];
  return states.map((state) => ({
    id: state.id,
    path: [state.label],
    icon: input.icon,
    selected: state.selected,
    testId: `command-center-${input.key}-${input.source.serverId}:${input.source.ownerKey}:${state.id}`,
    select: state.select,
  }));
}

function buildPlanModeGroup(source: AgentControlContributionSource): CommandCenterChoiceGroup {
  const planFeature = source.features.list.find(
    (feature) => feature.id === PLAN_MODE_FEATURE_ID && feature.type === "toggle",
  );
  let choices: CommandCenterChoice[] = [];
  if (planFeature?.type === "toggle") {
    choices = toggleChoices({
      source,
      key: "plan",
      icon: source.icons.feature(planFeature),
      isOn: planFeature.value,
      turnOn: () => source.features.set(PLAN_MODE_FEATURE_ID, true),
      turnOff: () => source.features.set(PLAN_MODE_FEATURE_ID, false),
    });
  } else {
    const planMode = source.modes.options.find((mode) => isPlanningAgentMode(mode.id));
    const offModeId =
      source.modes.defaultModeId ??
      source.modes.options.find((mode) => !isPlanningAgentMode(mode.id))?.id ??
      null;
    if (planMode && offModeId) {
      choices = toggleChoices({
        source,
        key: "plan",
        icon: source.icons.planMode,
        isOn: source.modes.selectedId === planMode.id,
        turnOn: () => source.modes.select(planMode.id),
        turnOff: () => source.modes.select(offModeId),
      });
    }
  }
  return {
    id: "plan-mode",
    rank: GROUP_RANK.planMode,
    label: source.labels.planMode,
    keywords: [source.labels.planKeywords],
    choices,
  };
}

function buildFastModeGroup(source: AgentControlContributionSource): CommandCenterChoiceGroup {
  const fastFeature = source.features.list.find(
    (feature) => feature.id === FAST_MODE_FEATURE_ID && feature.type === "toggle",
  );
  const choices =
    fastFeature?.type === "toggle"
      ? toggleChoices({
          source,
          key: "fast",
          icon: source.icons.feature(fastFeature),
          isOn: fastFeature.value,
          turnOn: () => source.features.set(FAST_MODE_FEATURE_ID, true),
          turnOff: () => source.features.set(FAST_MODE_FEATURE_ID, false),
        })
      : [];
  return {
    id: "fast-mode",
    rank: GROUP_RANK.fastMode,
    label: source.labels.fast,
    keywords: [source.labels.fastKeywords],
    choices,
  };
}

export function buildAgentControlContributions(
  source: AgentControlContributionSource,
): CommandCenterContribution[] {
  const groups = [buildModelGroup(source)];
  if (source.provider) {
    groups.push(
      buildThinkingGroup(source),
      buildModeGroup(source),
      buildPlanModeGroup(source),
      buildFastModeGroup(source),
    );
  }
  return buildContributions(groups);
}
