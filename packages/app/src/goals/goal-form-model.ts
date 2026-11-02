import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { deriveGoalTitle } from "./goal-chat-prefill";
import { prefillFromGoalFormMemory, type GoalFormMemory } from "./goal-form-memory";
import {
  basename,
  findGoalProject,
  resolveGoalProjectDefault,
  type GoalCwdCheck,
  type GoalCwdSource,
  type GoalProjectOption,
} from "./goal-projects";
import {
  DAEMON_GOAL_SETTINGS,
  GOAL_PRESETS,
  NO_GOAL_BUDGET,
  goalBudgetToLimits,
  goalSettingsToConfig,
  matchGoalSettingsChoice,
  normalizeGoalSettings,
  stepGoalBudget,
  supportedGoalSettings,
  stepGoalSetting,
  summarizeGoalSettings,
  type GoalBudget,
  type GoalBudgetKey,
  type GoalNumberSetting,
  type GoalPresetId,
  type GoalSettings,
  type GoalSettingsChoice,
  type GoalSettingsSummaryPart,
  type GoalThinkingRole,
  GOAL_THINKING_ROLES,
} from "./goal-settings";

export interface GoalFormValues {
  title: string;
  objective: string;
  criteriaText: string;
  /** Off: a manual goal that only records plans and state. On: the Manager runs it. */
  managed: boolean;
  cwd: string;
  leadProvider: string;
  /** Empty means the provider's default model. Sent as "provider/model". */
  leadModel: string;
  defaultProvider: string;
  defaultModel: string;
  /** Empty means the reviewer uses the Lead's provider and model. */
  reviewProvider: string;
  reviewModel: string;
  /**
   * Thinking option ids per role (a model's `thinkingOptions[].id`). Empty leaves the model's
   * default, and is what the form sends nothing for.
   */
  leadThinking: string;
  workerThinking: string;
  reviewThinking: string;
  verifyThinking: string;
  testCommand: string;
  /** Empty means any registered provider. */
  allowedProviders: string[];
  settings: GoalSettings;
  budget: GoalBudget;
}

/** The plain fields `setValue` edits; settings, budget and the allow-list have their own commands. */
export type GoalFormTextKey = Exclude<
  keyof GoalFormValues,
  "settings" | "budget" | "allowedProviders"
>;

export interface GoalCreateInput {
  title: string;
  objective: string;
  criteria: string[];
  config?: GoalConfig;
}

/** Values a caller seeds the form with, such as a chat, a template or your last goal. */
export interface GoalFormPrefill {
  title?: string;
  objective?: string;
  criteriaText?: string;
  managed?: boolean;
  cwd?: string;
  /** A provider id, or "provider/model". */
  leadProvider?: string;
  /** A provider id, or "provider/model". */
  defaultProvider?: string;
  /** A provider id, or "provider/model". */
  reviewProvider?: string;
  /** Thinking option ids; one the role's model does not list is dropped once providers load. */
  leadThinking?: string;
  workerThinking?: string;
  reviewThinking?: string;
  verifyThinking?: string;
  testCommand?: string;
  allowedProviders?: string[];
  /** Starts from a preset; wins over `settings`. */
  preset?: GoalPresetId;
  settings?: Partial<GoalSettings>;
  budget?: GoalBudget;
  /** The chat the goal is started from; the daemon posts the outcome back there. */
  originAgentId?: string;
  /** The commit the goal builds on instead of the project's HEAD, such as a failed goal's result. */
  baseCommit?: GoalFormBaseCommit;
}

/** A commit a new goal starts from, with what the form says about where it came from. */
export interface GoalFormBaseCommit {
  commit: string;
  /** The goal whose work the commit holds. */
  goalTitle: string;
  /** That goal's integration branch, when it had one. */
  branch: string | null;
}

/** The short form of a commit id the form shows. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/** A connected host that runs goals. */
export interface GoalFormHost {
  serverId: string;
  label: string;
  /** The host enforces token and cost caps (`goalBudgets`). */
  budgetSupported: boolean;
  /** The host takes a thinking level per role (`goalThinking`). */
  thinkingSupported: boolean;
  /** The host takes `userWaitMinutes` (`goalUserWait`). */
  userWaitSupported: boolean;
  /** The host takes the `auto` permission policy (`goalConfigEdit`). */
  autoPermissionSupported: boolean;
}

/** The chosen project as shown on the picker, captured when it is chosen. */
export interface GoalProjectDisplay {
  label: string;
  /** The directory the goal runs in. */
  path: string;
}

export interface GoalFormSnapshot {
  /** The host the form opens on. */
  serverId?: string;
  /** Values the caller opened the form with; they win over the remembered ones. */
  prefill?: GoalFormPrefill;
  /**
   * Your last managed goal per host. When given, the opened host's entry seeds the form under
   * the prefill, and switching hosts seeds from that host's entry.
   */
  memoryByServer?: Readonly<Record<string, GoalFormMemory>>;
  /** Your remembered settings: the starting point when no preset is given, and the "Mine" choice. */
  personalSettings?: GoalSettings | null;
  /** The host enforces token and cost caps. Without it the budget is never sent. */
  budgetSupported?: boolean;
  /** The host takes a thinking level per role. Without it no thinking is sent or offered. */
  thinkingSupported?: boolean;
  /** The host takes `userWaitMinutes`. Without it the wait limit is neither shown nor sent. */
  userWaitSupported?: boolean;
  /** The host takes the `auto` permission policy. Without it `auto` is neither offered nor sent. */
  autoPermissionSupported?: boolean;
}

export type GoalFormField =
  | "title"
  | "criteria"
  | "cwd"
  | "leadProvider"
  | "defaultProvider"
  | "allowedProviders";

export type GoalFormIssue =
  | { field: GoalFormField; code: "required" }
  | { field: "cwd"; code: "notGitRepo" }
  | { field: "allowedProviders"; code: "excludesRole"; provider: string };

export const EMPTY_GOAL_FORM_VALUES: GoalFormValues = {
  title: "",
  objective: "",
  criteriaText: "",
  managed: false,
  cwd: "",
  leadProvider: "",
  leadModel: "",
  defaultProvider: "",
  defaultModel: "",
  reviewProvider: "",
  reviewModel: "",
  leadThinking: "",
  workerThinking: "",
  reviewThinking: "",
  verifyThinking: "",
  testCommand: "",
  allowedProviders: [],
  settings: DAEMON_GOAL_SETTINGS,
  budget: NO_GOAL_BUDGET,
};

/** One acceptance criterion per non-blank line. */
export function parseGoalCriteria(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The title as sent: the one typed, or the objective's first line. */
export function resolveGoalTitle(values: Pick<GoalFormValues, "title" | "objective">): string {
  return values.title.trim() || deriveGoalTitle(values.objective);
}

/**
 * Every reason the values cannot be submitted; empty when they can. `cwdCheck` is what the host
 * said about the directory; it counts only while it is about the directory in the values.
 */
export function validateGoalForm(
  values: GoalFormValues,
  context: { cwdCheck?: GoalCwdCheck | null } = {},
): GoalFormIssue[] {
  const issues: GoalFormIssue[] = [];
  if (!resolveGoalTitle(values)) {
    issues.push({ field: "title", code: "required" });
  }
  if (!values.managed) {
    return issues;
  }
  if (parseGoalCriteria(values.criteriaText).length === 0) {
    issues.push({ field: "criteria", code: "required" });
  }
  for (const field of ["cwd", "leadProvider", "defaultProvider"] as const) {
    if (!values[field].trim()) {
      issues.push({ field, code: "required" });
    }
  }
  const cwd = values.cwd.trim();
  if (cwd && context.cwdCheck?.cwd === cwd && context.cwdCheck.status === "notGit") {
    issues.push({ field: "cwd", code: "notGitRepo" });
  }
  if (values.allowedProviders.length > 0) {
    const roles = [values.leadProvider, values.defaultProvider, values.reviewProvider];
    const excluded = roles.find(
      (provider) => provider.trim() && !values.allowedProviders.includes(provider),
    );
    if (excluded) {
      issues.push({ field: "allowedProviders", code: "excludesRole", provider: excluded });
    }
  }
  return issues;
}

/** The daemon takes "provider/model" wherever it takes a provider id; no model means its default. */
function composeProvider(provider: string, model: string): string {
  const trimmedProvider = provider.trim();
  const trimmedModel = model.trim();
  return trimmedModel ? `${trimmedProvider}/${trimmedModel}` : trimmedProvider;
}

/** Splits at the first slash, the way the daemon does (packages/server/src/server/goal/goal-ports.ts). */
function splitProvider(value: string): { provider: string; model: string } {
  const slash = value.indexOf("/");
  return slash < 0
    ? { provider: value, model: "" }
    : { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/**
 * The goal config exactly as `GoalConfigSchema` takes it, leaving out every optional field equal
 * to the daemon's default. Call only on values that validate.
 */
function buildGoalConfig(input: {
  values: GoalFormValues;
  originAgentId: string | null;
  budgetSupported: boolean;
  thinkingSupported: boolean;
  userWaitSupported: boolean;
  baseCommit?: string | null;
}): GoalConfig {
  const { values } = input;
  const reviewProvider = values.reviewProvider.trim()
    ? composeProvider(values.reviewProvider, values.reviewModel)
    : "";
  const testCommand = values.testCommand.trim();
  const settingsConfig = goalSettingsToConfig(values.settings, {
    userWaitSupported: input.userWaitSupported,
  });
  const limits = {
    ...settingsConfig.limits,
    ...(input.budgetSupported ? goalBudgetToLimits(values.budget) : {}),
  };
  const hasLimits = Object.keys(limits).length > 0;
  return {
    ...settingsConfig,
    cwd: values.cwd.trim(),
    leadProvider: composeProvider(values.leadProvider, values.leadModel),
    defaultProvider: composeProvider(values.defaultProvider, values.defaultModel),
    ...(hasLimits ? { limits } : {}),
    ...(reviewProvider ? { reviewProvider } : {}),
    ...(testCommand ? { testCommand } : {}),
    ...(values.allowedProviders.length > 0
      ? { allowedProviders: [...values.allowedProviders] }
      : {}),
    ...(input.originAgentId ? { originAgentId: input.originAgentId } : {}),
    ...(input.thinkingSupported ? goalThinkingConfig(values) : {}),
    ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
  };
}

const THINKING_FIELD = {
  lead: "leadThinking",
  worker: "workerThinking",
  reviewer: "reviewThinking",
  verifier: "verifyThinking",
} as const satisfies Record<GoalThinkingRole, keyof GoalConfig & keyof GoalFormValues>;

/** The thinking fields that are set; an unset one leaves the model's default. */
function goalThinkingConfig(
  values: GoalFormValues,
): Pick<GoalConfig, "leadThinking" | "workerThinking" | "reviewThinking" | "verifyThinking"> {
  const config: Pick<
    GoalConfig,
    "leadThinking" | "workerThinking" | "reviewThinking" | "verifyThinking"
  > = {};
  for (const role of GOAL_THINKING_ROLES) {
    const field = THINKING_FIELD[role];
    const value = values[field].trim();
    if (value) {
      config[field] = value;
    }
  }
  return config;
}

/** Returns null while the form cannot be submitted (see `validateGoalForm`). */
export function buildGoalCreateInput(
  values: GoalFormValues,
  options: {
    originAgentId?: string | null;
    budgetSupported?: boolean;
    thinkingSupported?: boolean;
    userWaitSupported?: boolean;
    cwdCheck?: GoalCwdCheck | null;
    baseCommit?: string | null;
  } = {},
): GoalCreateInput | null {
  if (validateGoalForm(values, { cwdCheck: options.cwdCheck }).length > 0) {
    return null;
  }
  const config = values.managed
    ? buildGoalConfig({
        values,
        originAgentId: options.originAgentId ?? null,
        budgetSupported: options.budgetSupported ?? false,
        thinkingSupported: options.thinkingSupported ?? false,
        userWaitSupported: options.userWaitSupported ?? false,
        baseCommit: options.baseCommit ?? null,
      })
    : null;
  return {
    title: resolveGoalTitle(values),
    objective: values.objective.trim(),
    criteria: parseGoalCriteria(values.criteriaText),
    ...(config ? { config } : {}),
  };
}

/** What happens after Create, sentence by sentence, under `goals.form.outcome`. */
export type GoalOutcomeStep =
  | "manual"
  | "planAuto"
  | "planReview"
  | "worktrees"
  | "mergeAsk"
  | "mergeReviewed"
  | "branch";

export function describeGoalOutcome(values: GoalFormValues): GoalOutcomeStep[] {
  if (!values.managed) {
    return ["manual"];
  }
  return [
    values.settings.autoApprovePlan ? "planAuto" : "planReview",
    "worktrees",
    values.settings.requireHumanApproval ? "mergeAsk" : "mergeReviewed",
    "branch",
  ];
}

export interface GoalThinkingOption {
  id: string;
  label?: string;
  description?: string;
  isDefault?: boolean;
}

export interface GoalModelOption {
  id: string;
  label: string;
  description?: string;
  /** The model the provider starts when none is named. */
  isDefault?: boolean;
  /** Absent or empty when the model offers no thinking levels. */
  thinkingOptions?: GoalThinkingOption[];
}

/**
 * The provider and model an agent in this role runs on, as the form sends them. The reviewer
 * runs on the Lead's when no review provider is chosen, and the verifier on the reviewer's: the
 * form does not set `verifyProvider`.
 */
export function goalRoleModel(
  values: GoalFormValues,
  role: GoalThinkingRole,
): { provider: string; model: string } {
  switch (role) {
    case "lead":
      return { provider: values.leadProvider, model: values.leadModel };
    case "worker":
      return { provider: values.defaultProvider, model: values.defaultModel };
    case "reviewer":
    case "verifier":
      return values.reviewProvider.trim()
        ? { provider: values.reviewProvider, model: values.reviewModel }
        : { provider: values.leadProvider, model: values.leadModel };
  }
}

/**
 * The thinking levels the role's model offers, or null while that is unknown: the providers
 * have not loaded, or the provider lists no such model. No model means the provider's default
 * one, found the way the daemon finds it.
 */
export function goalRoleThinkingOptions(
  values: GoalFormValues,
  providerOptions: readonly GoalProviderOption[],
  role: GoalThinkingRole,
): GoalThinkingOption[] | null {
  const { provider, model } = goalRoleModel(values, role);
  const models = providerOptions.find((option) => option.id === provider.trim())?.models ?? [];
  const modelId = model.trim();
  const definition = modelId
    ? models.find((entry) => entry.id === modelId)
    : (models.find((entry) => entry.isDefault) ?? models[0]);
  return definition ? (definition.thinkingOptions ?? []) : null;
}

/** Drops a thinking level the role's model does not list; keeps it while that is unknown. */
export function reconcileGoalThinking(
  values: GoalFormValues,
  providerOptions: readonly GoalProviderOption[],
): GoalFormValues {
  const cleared: Partial<Pick<GoalFormValues, (typeof THINKING_FIELD)[GoalThinkingRole]>> = {};
  for (const role of GOAL_THINKING_ROLES) {
    const field = THINKING_FIELD[role];
    const value = values[field];
    if (!value) {
      continue;
    }
    const options = goalRoleThinkingOptions(values, providerOptions, role);
    if (options && !options.some((option) => option.id === value)) {
      cleared[field] = "";
    }
  }
  return Object.keys(cleared).length > 0 ? { ...values, ...cleared } : values;
}

function thinkingSummary(
  values: GoalFormValues,
  thinkingOptions: Record<GoalThinkingRole, GoalThinkingOption[]>,
): GoalSettingsSummaryPart[] {
  return GOAL_THINKING_ROLES.flatMap((role): GoalSettingsSummaryPart[] => {
    const id = values[THINKING_FIELD[role]];
    if (!id) {
      return [];
    }
    const option = thinkingOptions[role].find((entry) => entry.id === id) ?? { id };
    return [{ key: "thinking", role, label: formatThinkingOptionLabel(option) }];
  });
}

export interface GoalProviderOption {
  id: string;
  label: string;
  /** Selectable models; absent or empty while the provider has not listed any. */
  models?: GoalModelOption[];
}

export interface GoalFormState {
  values: GoalFormValues;
  /** The host the goal is created on. */
  serverId: string;
  /** Hosts you can create the goal on; empty until they are applied. */
  hosts: GoalFormHost[];
  /** The host's git projects, most recently used first; empty until they arrive. */
  projectOptions: GoalProjectOption[];
  /** The project the directory belongs to, for marking it in the list. */
  selectedProjectId: string | null;
  projectDisplay: GoalProjectDisplay | null;
  /** How the directory was chosen. */
  cwdSource: GoalCwdSource;
  /** What the host said about the directory; null until asked. */
  cwdCheck: GoalCwdCheck | null;
  /** The typed folder path is open. */
  folderInputVisible: boolean;
  originAgentId: string | null;
  /** What the goal builds on instead of the project's HEAD; null for HEAD. */
  baseCommit: GoalFormBaseCommit | null;
  /** Providers registered on the host; empty until the providers snapshot arrives. */
  providerOptions: GoalProviderOption[];
  advancedExpanded: boolean;
  personalSettings: GoalSettings | null;
  budgetSupported: boolean;
  thinkingSupported: boolean;
  userWaitSupported: boolean;
  autoPermissionSupported: boolean;
  /** The thinking levels each role's model offers; empty hides that role's picker. */
  thinkingOptions: Record<GoalThinkingRole, GoalThinkingOption[]>;
  /** Fields you have edited; their issues show right away. The rest show after Create. */
  touched: readonly GoalFormField[];
  submitAttempted: boolean;
  issues: GoalFormIssue[];
  /** The issues to show now. */
  visibleIssues: GoalFormIssue[];
  createInput: GoalCreateInput | null;
  settingsChoice: GoalSettingsChoice;
  summary: GoalSettingsSummaryPart[];
  outcome: GoalOutcomeStep[];
  submitError: string | null;
}

export interface GoalFormModel {
  getState: () => GoalFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setValue: <Key extends GoalFormTextKey>(key: Key, value: GoalFormValues[Key]) => void;
  setSetting: <Key extends keyof GoalSettings>(key: Key, value: GoalSettings[Key]) => void;
  stepSetting: (key: GoalNumberSetting, direction: 1 | -1) => void;
  stepBudget: (key: GoalBudgetKey, direction: 1 | -1) => void;
  /** Sets a cap as typed or scrubbed; null is no cap. The caller keeps it in range. */
  setBudget: (key: GoalBudgetKey, value: number | null) => void;
  /** Replaces every setting with a preset's, or with your remembered ones. */
  chooseSettings: (choice: GoalPresetId | "mine") => void;
  toggleAllowedProvider: (provider: string) => void;
  setAdvancedExpanded: (expanded: boolean) => void;
  /** Late data: the hosts that can run goals. */
  applyHosts: (hosts: readonly GoalFormHost[]) => void;
  /**
   * Moves the goal to another host. Host-specific values (project, providers, test command, the
   * origin chat) restart from what you used last on that host.
   */
  setHost: (serverId: string) => void;
  /**
   * Late data: the host's git projects. Names the chosen directory, and fills an empty one with
   * the most recently used project.
   */
  applyProjectOptions: (options: readonly GoalProjectOption[]) => void;
  /** Runs the goal in a listed project's checkout. */
  chooseProject: (projectId: string) => void;
  /** Runs the goal in a folder chosen outside the list. */
  chooseFolder: (path: string) => void;
  setFolderInputVisible: (visible: boolean) => void;
  /** Late data: what the host said about a directory; ignored once the directory changed. */
  applyCwdCheck: (check: GoalCwdCheck) => void;
  /** Reveals every issue; the caller submits only when `createInput` is set. */
  attemptSubmit: () => void;
  /**
   * Late data: the host's registered providers. Drops selections the host lacks, then fills an
   * empty Lead with the first allowed provider and empty workers with the Lead's.
   */
  applyProviderOptions: (options: readonly GoalProviderOption[]) => void;
  setSubmitError: (message: string | null) => void;
  /** Starts the goal from the project's HEAD instead of the prefilled commit. */
  clearBaseCommit: () => void;
}

/** Each provider field and the model chosen for it. Changing the provider resets the model. */
const MODEL_FIELD_BY_PROVIDER = {
  leadProvider: "leadModel",
  defaultProvider: "defaultModel",
  reviewProvider: "reviewModel",
} as const satisfies Partial<Record<GoalFormTextKey, GoalFormTextKey>>;

const PROVIDER_FIELDS = Object.keys(
  MODEL_FIELD_BY_PROVIDER,
) as (keyof typeof MODEL_FIELD_BY_PROVIDER)[];

function isProviderField(key: GoalFormTextKey): key is keyof typeof MODEL_FIELD_BY_PROVIDER {
  return key in MODEL_FIELD_BY_PROVIDER;
}

const FIELD_OF_KEY: Partial<Record<GoalFormTextKey, GoalFormField>> = {
  title: "title",
  objective: "title",
  criteriaText: "criteria",
  cwd: "cwd",
  leadProvider: "leadProvider",
  defaultProvider: "defaultProvider",
  reviewProvider: "allowedProviders",
};

/** Drops selections the host's provider list rules out; an empty list rules nothing out. */
function reconcileWithOptions(
  values: GoalFormValues,
  options: readonly GoalProviderOption[],
): GoalFormValues {
  if (options.length === 0) {
    return values;
  }
  const next = {
    ...values,
    allowedProviders: values.allowedProviders.filter((id) =>
      options.some((option) => option.id === id),
    ),
  };
  for (const field of PROVIDER_FIELDS) {
    const modelField = MODEL_FIELD_BY_PROVIDER[field];
    const option = options.find((candidate) => candidate.id === next[field]);
    if (next[field] && !option) {
      next[field] = "";
      next[modelField] = "";
      continue;
    }
    const models = option?.models ?? [];
    if (next[modelField] && models.length > 0 && !models.some((m) => m.id === next[modelField])) {
      next[modelField] = "";
    }
  }
  const firstAllowed = options.find(
    (option) => next.allowedProviders.length === 0 || next.allowedProviders.includes(option.id),
  );
  if (!next.leadProvider) {
    next.leadProvider = next.defaultProvider || (firstAllowed?.id ?? "");
  }
  if (!next.defaultProvider) {
    next.defaultProvider = next.leadProvider;
  }
  return next;
}

type BaseState = Omit<
  GoalFormState,
  | "issues"
  | "visibleIssues"
  | "createInput"
  | "settingsChoice"
  | "summary"
  | "outcome"
  | "selectedProjectId"
  | "thinkingOptions"
>;

function withDerived(input: BaseState): GoalFormState {
  // A remembered `auto` cannot reach a host that would reject it.
  const settings = supportedGoalSettings(input.values.settings, input.autoPermissionSupported);
  const state =
    settings === input.values.settings
      ? input
      : { ...input, values: { ...input.values, settings } };
  const issues = validateGoalForm(state.values, { cwdCheck: state.cwdCheck });
  const optionsFor = (role: GoalThinkingRole): GoalThinkingOption[] =>
    state.thinkingSupported
      ? (goalRoleThinkingOptions(state.values, state.providerOptions, role) ?? [])
      : [];
  const thinkingOptions: Record<GoalThinkingRole, GoalThinkingOption[]> = {
    lead: optionsFor("lead"),
    worker: optionsFor("worker"),
    reviewer: optionsFor("reviewer"),
    verifier: optionsFor("verifier"),
  };
  return {
    ...state,
    thinkingOptions,
    selectedProjectId: findGoalProject(state.projectOptions, state.values.cwd)?.projectId ?? null,
    issues,
    // The host's verdict on the directory shows at once: you did not type it to be told later.
    visibleIssues: state.submitAttempted
      ? issues
      : issues.filter(
          (issue) => issue.code === "notGitRepo" || state.touched.includes(issue.field),
        ),
    createInput: buildGoalCreateInput(state.values, {
      originAgentId: state.originAgentId,
      budgetSupported: state.budgetSupported,
      thinkingSupported: state.thinkingSupported,
      userWaitSupported: state.userWaitSupported,
      cwdCheck: state.cwdCheck,
      baseCommit: state.baseCommit?.commit ?? null,
    }),
    settingsChoice: matchGoalSettingsChoice(state.values.settings, state.personalSettings),
    summary: [
      ...summarizeGoalSettings(state.values.settings, {
        hasTestCommand: state.values.testCommand.trim().length > 0,
      }),
      ...(state.thinkingSupported ? thinkingSummary(state.values, thinkingOptions) : []),
    ],
    outcome: describeGoalOutcome(state.values),
  };
}

function initialSettings(snapshot: GoalFormSnapshot): GoalSettings {
  const prefill = snapshot.prefill ?? {};
  if (prefill.preset) {
    return GOAL_PRESETS[prefill.preset];
  }
  if (prefill.settings) {
    return normalizeGoalSettings(prefill.settings);
  }
  return snapshot.personalSettings ?? DAEMON_GOAL_SETTINGS;
}

/** The prefill the form opens with: the caller's values over the host's remembered ones. */
function resolveOpeningPrefill(snapshot: GoalFormSnapshot): {
  prefill: GoalFormPrefill;
  cwdSource: GoalCwdSource;
} {
  const explicit = snapshot.prefill ?? {};
  if (!snapshot.memoryByServer) {
    return { prefill: explicit, cwdSource: explicit.cwd?.trim() ? "prefill" : "none" };
  }
  const memory = snapshot.memoryByServer[snapshot.serverId ?? ""] ?? null;
  const fromMemory = prefillFromGoalFormMemory(memory, { cwd: explicit.cwd });
  const { cwd, source } = resolveGoalProjectDefault({
    prefillCwd: explicit.cwd,
    rememberedCwd: memory?.cwd,
    options: [],
  });
  return { prefill: { ...fromMemory, ...explicit, cwd }, cwdSource: source };
}

function valuesFromPrefill(prefill: GoalFormPrefill, settings: GoalSettings): GoalFormValues {
  const lead = splitProvider(prefill.leadProvider ?? "");
  const fallback = splitProvider(prefill.defaultProvider ?? "");
  const review = splitProvider(prefill.reviewProvider ?? "");
  return {
    ...EMPTY_GOAL_FORM_VALUES,
    title: prefill.title ?? "",
    objective: prefill.objective ?? "",
    criteriaText: prefill.criteriaText ?? "",
    managed: prefill.managed ?? false,
    cwd: prefill.cwd ?? "",
    leadProvider: lead.provider,
    leadModel: lead.model,
    defaultProvider: fallback.provider,
    defaultModel: fallback.model,
    reviewProvider: review.provider,
    reviewModel: review.model,
    leadThinking: prefill.leadThinking ?? "",
    workerThinking: prefill.workerThinking ?? "",
    reviewThinking: prefill.reviewThinking ?? "",
    verifyThinking: prefill.verifyThinking ?? "",
    testCommand: prefill.testCommand ?? "",
    allowedProviders: prefill.allowedProviders ?? [],
    settings,
    budget: prefill.budget ?? NO_GOAL_BUDGET,
  };
}

/** The picker's label for a directory: its project's name, or the folder's own name. */
function projectDisplayFor(
  options: readonly GoalProjectOption[],
  cwd: string,
): GoalProjectDisplay | null {
  const path = cwd.trim();
  if (!path) {
    return null;
  }
  return { label: findGoalProject(options, path)?.name ?? basename(path), path };
}

export function openGoalForm(snapshot: GoalFormSnapshot): GoalFormModel {
  const opening = resolveOpeningPrefill(snapshot);
  const prefill = opening.prefill;
  const memoryByServer = snapshot.memoryByServer ?? {};
  // The prefilled commit belongs to this directory's repository.
  const baseCommitCwd = (prefill.cwd ?? "").trim();
  const listeners = new Set<() => void>();
  let closed = false;
  let state = withDerived({
    values: valuesFromPrefill(prefill, initialSettings({ ...snapshot, prefill })),
    serverId: snapshot.serverId ?? "",
    hosts: [],
    projectOptions: [],
    projectDisplay: projectDisplayFor([], prefill.cwd ?? ""),
    cwdSource: opening.cwdSource,
    cwdCheck: null,
    folderInputVisible: false,
    originAgentId: prefill.originAgentId ?? null,
    baseCommit: prefill.baseCommit?.commit.trim() ? prefill.baseCommit : null,
    providerOptions: [],
    advancedExpanded: false,
    personalSettings: snapshot.personalSettings ?? null,
    budgetSupported: snapshot.budgetSupported ?? false,
    thinkingSupported: snapshot.thinkingSupported ?? false,
    userWaitSupported: snapshot.userWaitSupported ?? false,
    autoPermissionSupported: snapshot.autoPermissionSupported ?? false,
    touched: [],
    submitAttempted: false,
    submitError: null,
  });

  function publish(next: BaseState): void {
    if (closed) {
      return;
    }
    state = withDerived(next);
    for (const listener of listeners) {
      listener();
    }
  }

  function touch(field: GoalFormField | undefined): readonly GoalFormField[] {
    return field && !state.touched.includes(field) ? [...state.touched, field] : state.touched;
  }

  function setSettings(settings: GoalSettings): void {
    publish({ ...state, values: { ...state.values, settings } });
  }

  /** A directory you picked, typed or chose from the list. */
  function setCwd(cwd: string, folderInputVisible: boolean): void {
    publish({
      ...state,
      values: { ...state.values, cwd },
      projectDisplay: projectDisplayFor(state.projectOptions, cwd),
      cwdSource: "manual",
      cwdCheck: state.cwdCheck?.cwd === cwd.trim() ? state.cwdCheck : null,
      // Another project's repository need not have the commit; the goal then starts at its HEAD.
      baseCommit: cwd.trim() === baseCommitCwd ? state.baseCommit : null,
      folderInputVisible,
      touched: touch("cwd"),
      submitError: null,
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    setValue(key, value) {
      if (key === "cwd" && typeof value === "string") {
        setCwd(value, state.folderInputVisible);
        return;
      }
      const values = { ...state.values, [key]: value };
      if (isProviderField(key) && value !== state.values[key]) {
        values[MODEL_FIELD_BY_PROVIDER[key]] = "";
      }
      publish({
        ...state,
        // A new provider or model may not offer the thinking level chosen for the old one.
        values: reconcileGoalThinking(values, state.providerOptions),
        touched: touch(FIELD_OF_KEY[key]),
        submitError: null,
      });
    },
    setSetting(key, value) {
      setSettings({ ...state.values.settings, [key]: value });
    },
    stepSetting(key, direction) {
      setSettings({
        ...state.values.settings,
        [key]: stepGoalSetting(key, state.values.settings[key], direction),
      });
    },
    stepBudget(key, direction) {
      const budget = {
        ...state.values.budget,
        [key]: stepGoalBudget(key, state.values.budget[key], direction),
      };
      publish({ ...state, values: { ...state.values, budget } });
    },
    setBudget(key, value) {
      publish({
        ...state,
        values: { ...state.values, budget: { ...state.values.budget, [key]: value } },
      });
    },
    chooseSettings(choice) {
      const settings = choice === "mine" ? state.personalSettings : GOAL_PRESETS[choice];
      if (settings) {
        setSettings(settings);
      }
    },
    toggleAllowedProvider(provider) {
      const current = state.values.allowedProviders;
      const allowedProviders = current.includes(provider)
        ? current.filter((id) => id !== provider)
        : [...current, provider];
      publish({
        ...state,
        values: { ...state.values, allowedProviders },
        touched: touch("allowedProviders"),
      });
    },
    setAdvancedExpanded(expanded) {
      publish({ ...state, advancedExpanded: expanded });
    },
    applyHosts(hosts) {
      const host = hosts.find((candidate) => candidate.serverId === state.serverId);
      publish({
        ...state,
        hosts: [...hosts],
        budgetSupported: host ? host.budgetSupported : state.budgetSupported,
        thinkingSupported: host ? host.thinkingSupported : state.thinkingSupported,
        userWaitSupported: host ? host.userWaitSupported : state.userWaitSupported,
        autoPermissionSupported: host
          ? host.autoPermissionSupported
          : state.autoPermissionSupported,
      });
    },
    setHost(serverId) {
      if (serverId === state.serverId) {
        return;
      }
      const memory = memoryByServer[serverId] ?? null;
      const seeded = valuesFromPrefill(
        prefillFromGoalFormMemory(memory, {}),
        state.values.settings,
      );
      const host = state.hosts.find((candidate) => candidate.serverId === serverId);
      const cwd = memory?.cwd ?? "";
      publish({
        ...state,
        serverId,
        values: {
          ...state.values,
          cwd,
          leadProvider: seeded.leadProvider,
          leadModel: seeded.leadModel,
          defaultProvider: seeded.defaultProvider,
          defaultModel: seeded.defaultModel,
          reviewProvider: seeded.reviewProvider,
          reviewModel: seeded.reviewModel,
          leadThinking: seeded.leadThinking,
          workerThinking: seeded.workerThinking,
          reviewThinking: seeded.reviewThinking,
          verifyThinking: seeded.verifyThinking,
          testCommand: seeded.testCommand,
          allowedProviders: seeded.allowedProviders,
        },
        // The chat lives on the old host; the daemon cannot post back to it from here.
        originAgentId: null,
        // So does the commit: another host's repository does not have it.
        baseCommit: null,
        projectOptions: [],
        projectDisplay: projectDisplayFor([], cwd),
        cwdSource: cwd ? "memory" : "none",
        cwdCheck: null,
        folderInputVisible: false,
        providerOptions: [],
        personalSettings: memory?.settings ?? null,
        budgetSupported: host?.budgetSupported ?? false,
        thinkingSupported: host?.thinkingSupported ?? false,
        userWaitSupported: host?.userWaitSupported ?? false,
        autoPermissionSupported: host?.autoPermissionSupported ?? false,
        submitError: null,
      });
    },
    applyProjectOptions(options) {
      const projectOptions = [...options];
      const untouched = state.cwdSource === "none" && !state.values.cwd.trim();
      const fallback = untouched
        ? resolveGoalProjectDefault({ options: projectOptions })
        : { cwd: state.values.cwd, source: state.cwdSource };
      publish({
        ...state,
        values: { ...state.values, cwd: fallback.cwd },
        projectOptions,
        // The label is named once, when the first list arrives; later churn never relabels it.
        projectDisplay:
          state.projectOptions.length > 0 && state.projectDisplay
            ? state.projectDisplay
            : projectDisplayFor(projectOptions, fallback.cwd),
        cwdSource: fallback.source,
      });
    },
    chooseProject(projectId) {
      const option = state.projectOptions.find((candidate) => candidate.projectId === projectId);
      if (option) {
        setCwd(option.rootPath, false);
      }
    },
    chooseFolder(path) {
      if (path.trim()) {
        setCwd(path.trim(), state.folderInputVisible);
      }
    },
    setFolderInputVisible(visible) {
      publish({ ...state, folderInputVisible: visible });
    },
    applyCwdCheck(check) {
      if (check.cwd !== state.values.cwd.trim()) {
        return;
      }
      publish({ ...state, cwdCheck: check });
    },
    attemptSubmit() {
      publish({ ...state, submitAttempted: true });
    },
    applyProviderOptions(options) {
      publish({
        ...state,
        values: reconcileGoalThinking(reconcileWithOptions(state.values, options), options),
        providerOptions: [...options],
      });
    },
    setSubmitError(message) {
      publish({ ...state, submitError: message });
    },
    clearBaseCommit() {
      publish({ ...state, baseCommit: null, submitError: null });
    },
  };
}
