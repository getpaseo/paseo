import type { AgentFeature, AgentMode, AgentSelectOption } from "@getpaseo/protocol/agent-types";
import { formatThinkingOptionLabel } from "@/composer/agent-controls/utils";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

/** Codex exposes plan mode as a feature toggle rather than a permission mode. */
const PLAN_MODE_FEATURE_ID = "plan_mode";
const FAST_MODE_FEATURE_ID = "fast_mode";

// Agent-scoped selectors slot right after the model rows (groupRank 1, see
// model-contributions.ts) and before the built-in Workspaces (rank 2) and Agents
// (rank 3) sections, so every agent control clusters together at the top rather
// than sinking below the workspace/agent results.
const GROUP_RANK = {
  thinking: 1.1,
  modes: 1.2,
  planMode: 1.3,
  fastMode: 1.4,
} as const;

/**
 * Claude & OpenCode name their planning mode `"plan"`; Copilot uses an ACP
 * session-mode URI ending in `#plan`. Access-mode rows exclude these because
 * plan mode gets its own dedicated On/Off toggle.
 */
export function isPlanMode(modeId: string): boolean {
  return modeId === "plan" || modeId.endsWith("#plan");
}

export interface AgentSettingLabels {
  thinking: string;
  mode: string;
  planMode: string;
  fast: string;
  on: string;
  off: string;
  thinkingKeywords: string;
  modeKeywords: string;
  planKeywords: string;
  fastKeywords: string;
}

export interface AgentSettingIcons {
  thinking: CommandCenterIcon;
  planMode: CommandCenterIcon;
  fast: CommandCenterIcon;
  mode(modeId: string): CommandCenterIcon;
}

/** Builds the localized labels for the settings rows from a translate function. */
export function buildAgentSettingLabels(t: (key: string) => string): AgentSettingLabels {
  return {
    thinking: t("shell.commandCenter.thinkingGroupLabel"),
    mode: t("shell.commandCenter.modeGroupLabel"),
    planMode: t("shell.commandCenter.planModeGroupLabel"),
    fast: t("shell.commandCenter.fastModeGroupLabel"),
    on: t("shell.commandCenter.settingOn"),
    off: t("shell.commandCenter.settingOff"),
    thinkingKeywords: t("shell.commandCenter.thinkingSearchKeywords"),
    modeKeywords: t("shell.commandCenter.modeSearchKeywords"),
    planKeywords: t("shell.commandCenter.planModeSearchKeywords"),
    fastKeywords: t("shell.commandCenter.fastModeSearchKeywords"),
  };
}

/** Reads a feature's current value from a live agent's feature list. */
export function getFeatureValue(
  features: readonly AgentFeature[] | undefined,
  featureId: string,
): unknown {
  const feature = features?.find((item) => item.id === featureId);
  return feature && "value" in feature ? feature.value : undefined;
}

/**
 * Normalized view of an agent's adjustable settings, built by the active-agent
 * ({@link AgentControls}) and draft ({@link WorkspaceDraftAgentTab}) call sites so
 * the builders below stay pure and unit-testable.
 */
export interface AgentSettingsSource {
  serverId: string;
  /** agentId for a running agent, or the draft tabId — used only for contribution ids. */
  ownerKey: string;
  provider: string | null;
  labels: AgentSettingLabels;
  icons: AgentSettingIcons;
  thinking: {
    options: readonly AgentSelectOption[];
    selectedId: string | null;
    select(optionId: string): void;
  };
  modes: {
    options: readonly AgentMode[];
    selectedId: string | null;
    /** Mode to return to when plan mode is toggled off (provider default). */
    defaultModeId: string | null;
    select(modeId: string): void;
  };
  features: {
    /** Available features — presence of `fast_mode`/`plan_mode` gates those rows. */
    list: readonly AgentFeature[];
    value(featureId: string): unknown;
    set(featureId: string, value: unknown): void;
  };
}

function buildThinkingContributions(src: AgentSettingsSource): CommandCenterContribution[] {
  // A single option isn't a meaningful choice — mirrors the composer's thinking control.
  if (src.thinking.options.length <= 1) return [];
  return src.thinking.options.map((option, index): CommandCenterContribution => {
    const selected = option.id === src.thinking.selectedId;
    return {
      id: `${src.serverId}:${src.ownerKey}:thinking:${option.id}`,
      group: "thinking",
      groupRank: GROUP_RANK.thinking,
      rank: index,
      keywords: [src.labels.thinkingKeywords],
      visibility: "query",
      run: () => {
        if (!selected) src.thinking.select(option.id);
      },
      presentation: {
        kind: "choice",
        path: [src.labels.thinking, formatThinkingOptionLabel(option)],
        icon: src.icons.thinking,
        selected,
        testId: `command-center-thinking-${src.serverId}:${src.ownerKey}:${option.id}`,
      },
    };
  });
}

function buildModeContributions(src: AgentSettingsSource): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [];
  let rank = 0;
  for (const mode of src.modes.options) {
    if (isPlanMode(mode.id)) continue; // plan lives in its own toggle
    const selected = mode.id === src.modes.selectedId;
    contributions.push({
      id: `${src.serverId}:${src.ownerKey}:mode:${mode.id}`,
      group: "modes",
      groupRank: GROUP_RANK.modes,
      rank,
      keywords: [src.labels.modeKeywords],
      visibility: "query",
      run: () => {
        if (!selected) src.modes.select(mode.id);
      },
      presentation: {
        kind: "choice",
        path: [src.labels.mode, mode.label],
        icon: src.icons.mode(mode.id),
        selected,
        testId: `command-center-mode-${src.serverId}:${src.ownerKey}:${mode.id}`,
      },
    });
    rank += 1;
  }
  return contributions;
}

interface ToggleInput {
  src: AgentSettingsSource;
  key: string;
  group: string;
  groupRank: number;
  label: string;
  keywords: string;
  icon: CommandCenterIcon;
  isOn: boolean;
  turnOn(): void;
  turnOff(): void;
}

// Renders a setting as two breadcrumb rows ("<Label> › On" / "<Label> › Off") with
// a check on the current state, matching the tiered display of the model/thinking rows.
function buildToggleContributions(input: ToggleInput): CommandCenterContribution[] {
  const states = [
    { on: true, label: input.src.labels.on },
    { on: false, label: input.src.labels.off },
  ];
  return states.map((state, index): CommandCenterContribution => {
    const selected = input.isOn === state.on;
    return {
      id: `${input.src.serverId}:${input.src.ownerKey}:${input.key}:${state.on ? "on" : "off"}`,
      group: input.group,
      groupRank: input.groupRank,
      rank: index,
      keywords: [input.keywords],
      visibility: "query",
      run: () => {
        if (selected) return;
        if (state.on) input.turnOn();
        else input.turnOff();
      },
      presentation: {
        kind: "choice",
        path: [input.label, state.label],
        icon: input.icon,
        selected,
        testId: `command-center-${input.key}-${input.src.serverId}:${input.src.ownerKey}:${
          state.on ? "on" : "off"
        }`,
      },
    };
  });
}

function buildPlanModeContributions(src: AgentSettingsSource): CommandCenterContribution[] {
  const planFeature = src.features.list.find((feature) => feature.id === PLAN_MODE_FEATURE_ID);
  if (planFeature) {
    // Codex: plan mode is a feature toggle.
    return buildToggleContributions({
      src,
      key: "plan",
      group: "plan-mode",
      groupRank: GROUP_RANK.planMode,
      label: src.labels.planMode,
      keywords: src.labels.planKeywords,
      icon: src.icons.planMode,
      isOn: Boolean(src.features.value(PLAN_MODE_FEATURE_ID)),
      turnOn: () => src.features.set(PLAN_MODE_FEATURE_ID, true),
      turnOff: () => src.features.set(PLAN_MODE_FEATURE_ID, false),
    });
  }

  const planMode = src.modes.options.find((mode) => isPlanMode(mode.id));
  if (!planMode) return [];
  // Claude/Copilot/OpenCode: plan is a permission mode. "Off" returns to the
  // provider default (or the first non-plan mode if there is no default).
  const offModeId =
    src.modes.defaultModeId ?? src.modes.options.find((mode) => !isPlanMode(mode.id))?.id ?? null;
  if (!offModeId) return [];
  return buildToggleContributions({
    src,
    key: "plan",
    group: "plan-mode",
    groupRank: GROUP_RANK.planMode,
    label: src.labels.planMode,
    keywords: src.labels.planKeywords,
    icon: src.icons.planMode,
    isOn: src.modes.selectedId === planMode.id,
    turnOn: () => src.modes.select(planMode.id),
    turnOff: () => src.modes.select(offModeId),
  });
}

function buildFastModeContributions(src: AgentSettingsSource): CommandCenterContribution[] {
  const fastFeature = src.features.list.find((feature) => feature.id === FAST_MODE_FEATURE_ID);
  if (!fastFeature) return []; // model-gated: absent when the model doesn't support it
  return buildToggleContributions({
    src,
    key: "fast",
    group: "fast-mode",
    groupRank: GROUP_RANK.fastMode,
    label: src.labels.fast,
    keywords: src.labels.fastKeywords,
    icon: src.icons.fast,
    isOn: Boolean(src.features.value(FAST_MODE_FEATURE_ID)),
    turnOn: () => src.features.set(FAST_MODE_FEATURE_ID, true),
    turnOff: () => src.features.set(FAST_MODE_FEATURE_ID, false),
  });
}

/**
 * Builds the Command Center "choice" contributions for an agent's reasoning
 * (Thinking), access Mode, Plan mode, and Fast mode. All are query-gated so the
 * default palette view is unchanged. Registered from the composer subtree by the
 * active-agent and draft call sites.
 */
export function buildAgentSettingContributions(
  src: AgentSettingsSource,
): CommandCenterContribution[] {
  if (!src.provider) return [];
  return [
    ...buildThinkingContributions(src),
    ...buildModeContributions(src),
    ...buildPlanModeContributions(src),
    ...buildFastModeContributions(src),
  ];
}
