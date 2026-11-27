import type {
  AgentMode,
  AgentModelDefinition,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import type {
  AgentProfile,
  AgentTeamConfigWire,
  AgentTeamRoleConfigWire,
  AgentTeamsConfigWire,
} from "@getpaseo/protocol/messages";
import { formatAgentModeLabel } from "@/agent-controls/labels";
import { filterSelectableModels } from "@/provider-selection/model-catalog";

export interface TeamFormDisplay {
  label: string;
}

export interface TeamFormOption {
  id: string;
  value: string;
  label: string;
  description?: string;
  testID: string;
}

/** `""` leaves `isolation` unset, so the chat decides. */
export type TeamRoleIsolation = "" | "local" | "worktree";

export interface TeamRoleDraft {
  /** Local identity for React keys and commands; never persisted. */
  key: string;
  name: string;
  description: string;
  /** `provider:<id>` or `profile:<id>`; `""` until chosen. */
  agent: string;
  agentDisplay: TeamFormDisplay | null;
  model: string;
  modelDisplay: TeamFormDisplay | null;
  modeId: string;
  modeDisplay: TeamFormDisplay | null;
  /** Kept from the stored role while provider and model are unchanged; the form has no control for it. */
  thinkingOptionId: string;
  isolation: TeamRoleIsolation;
  /** Fields this client does not know, written back untouched. */
  extra: Record<string, unknown>;
}

export type TeamNameIssue = "required" | "duplicate" | null;

export interface TeamRoleIssues {
  name: TeamNameIssue;
  description: boolean;
  agent: boolean;
}

export interface TeamFormSnapshot {
  mode: "create" | "edit";
  /** The team being edited; required in edit mode. */
  teamName?: string;
  team?: AgentTeamConfigWire;
  /** Every team on the host, for the duplicate-name check. */
  existingTeamNames: readonly string[];
}

export interface TeamFormState {
  mode: "create" | "edit";
  originalName: string | null;
  name: string;
  description: string;
  peerMessaging: boolean;
  roles: TeamRoleDraft[];
  entries: readonly ProviderSnapshotEntry[];
  profiles: readonly AgentProfile[];
  agentOptions: TeamFormOption[];
  nameIssue: TeamNameIssue;
  roleIssues: Record<string, TeamRoleIssues>;
  isSubmitting: boolean;
  submitError: string | null;
  canSubmit: boolean;
  submitValue: { name: string; team: AgentTeamConfigWire } | null;
}

export interface TeamFormModel {
  getState: () => TeamFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  /** Late input: the host's provider catalog. Upgrades displays, never changes selections. */
  applyProviderCatalog: (entries: readonly ProviderSnapshotEntry[]) => void;
  /** Late input: the host's agent profiles. */
  applyProfiles: (profiles: readonly AgentProfile[]) => void;
  setName: (value: string) => void;
  setDescription: (value: string) => void;
  setPeerMessaging: (value: boolean) => void;
  addRole: () => void;
  removeRole: (key: string) => void;
  setRoleName: (key: string, value: string) => void;
  setRoleDescription: (key: string, value: string) => void;
  setRoleAgent: (key: string, agent: string, display: TeamFormDisplay) => void;
  setRoleModel: (key: string, model: string, display: TeamFormDisplay | null) => void;
  setRoleMode: (key: string, modeId: string, display: TeamFormDisplay | null) => void;
  setRoleIsolation: (key: string, isolation: TeamRoleIsolation) => void;
  setSubmitting: (value: boolean) => void;
  setSubmitError: (value: string | null) => void;
}

const PROVIDER_PREFIX = "provider:";
const PROFILE_PREFIX = "profile:";

export function parseRoleAgent(agent: string): { kind: "provider" | "profile"; id: string } | null {
  if (agent.startsWith(PROVIDER_PREFIX) && agent.length > PROVIDER_PREFIX.length) {
    return { kind: "provider", id: agent.slice(PROVIDER_PREFIX.length) };
  }
  if (agent.startsWith(PROFILE_PREFIX) && agent.length > PROFILE_PREFIX.length) {
    return { kind: "profile", id: agent.slice(PROFILE_PREFIX.length) };
  }
  return null;
}

function findEntry(
  entries: readonly ProviderSnapshotEntry[],
  provider: string,
): ProviderSnapshotEntry | null {
  return entries.find((entry) => entry.provider === provider) ?? null;
}

export function roleModels(
  entries: readonly ProviderSnapshotEntry[],
  agent: string,
): AgentModelDefinition[] {
  const parsed = parseRoleAgent(agent);
  if (parsed?.kind !== "provider") return [];
  return filterSelectableModels(findEntry(entries, parsed.id)?.models ?? null) ?? [];
}

export function roleModes(entries: readonly ProviderSnapshotEntry[], agent: string): AgentMode[] {
  const parsed = parseRoleAgent(agent);
  if (parsed?.kind !== "provider") return [];
  return findEntry(entries, parsed.id)?.modes ?? [];
}

function teamFormOption(input: {
  value: string;
  label: string;
  description: string | undefined;
  testID: string;
}): TeamFormOption {
  const option: TeamFormOption = {
    id: input.value,
    value: input.value,
    label: input.label,
    testID: input.testID,
  };
  if (input.description) option.description = input.description;
  return option;
}

export function buildRoleModelOptions(
  entries: readonly ProviderSnapshotEntry[],
  agent: string,
): TeamFormOption[] {
  return roleModels(entries, agent).map((model) => ({
    id: model.id,
    value: model.id,
    label: model.label,
    description: model.description ?? model.id,
    testID: `team-role-model-option-${model.id}`,
  }));
}

export function buildRoleModeOptions(
  entries: readonly ProviderSnapshotEntry[],
  agent: string,
): TeamFormOption[] {
  return roleModes(entries, agent).map((mode) =>
    teamFormOption({
      value: mode.id,
      label: formatAgentModeLabel(mode),
      description: mode.description,
      testID: `team-role-mode-option-${mode.id}`,
    }),
  );
}

function buildAgentOptions(
  entries: readonly ProviderSnapshotEntry[],
  profiles: readonly AgentProfile[],
): TeamFormOption[] {
  const providers = entries
    .filter((entry) => entry.enabled)
    .map((entry) =>
      teamFormOption({
        value: `${PROVIDER_PREFIX}${entry.provider}`,
        label: entry.label ?? entry.provider,
        description: entry.description,
        testID: `team-role-agent-option-provider-${entry.provider}`,
      }),
    );
  const profileOptions = profiles.map((profile) => ({
    id: `${PROFILE_PREFIX}${profile.id}`,
    value: `${PROFILE_PREFIX}${profile.id}`,
    label: profile.name,
    description: [profile.provider, profile.model].filter(Boolean).join(" / "),
    testID: `team-role-agent-option-profile-${profile.id}`,
  }));
  return [...providers, ...profileOptions];
}

/** A stored role names a profile by id or by name; the form always stores the id when it can. */
function findProfile(profiles: readonly AgentProfile[], reference: string): AgentProfile | null {
  return (
    profiles.find((profile) => profile.id === reference) ??
    profiles.find((profile) => profile.name === reference) ??
    null
  );
}

const KNOWN_ROLE_FIELDS = new Set([
  "description",
  "profile",
  "provider",
  "model",
  "modeId",
  "thinkingOptionId",
  "isolation",
]);
const KNOWN_TEAM_FIELDS = new Set(["description", "peerMessaging", "roles"]);

function pickExtra(record: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key)));
}

function toIsolation(value: string | undefined): TeamRoleIsolation {
  return value === "local" || value === "worktree" ? value : "";
}

function seedRole(key: string, name: string, role: AgentTeamRoleConfigWire): TeamRoleDraft {
  let agent = "";
  if (role.profile) agent = `${PROFILE_PREFIX}${role.profile}`;
  else if (role.provider) agent = `${PROVIDER_PREFIX}${role.provider}`;
  return {
    key,
    name,
    description: role.description,
    agent,
    agentDisplay:
      role.profile || role.provider ? { label: role.profile ?? role.provider ?? "" } : null,
    model: role.model ?? "",
    modelDisplay: role.model ? { label: role.model } : null,
    modeId: role.modeId ?? "",
    modeDisplay: role.modeId ? { label: role.modeId } : null,
    thinkingOptionId: role.thinkingOptionId ?? "",
    isolation: toIsolation(role.isolation),
    extra: pickExtra(role, KNOWN_ROLE_FIELDS),
  };
}

function emptyRole(key: string): TeamRoleDraft {
  return {
    key,
    name: "",
    description: "",
    agent: "",
    agentDisplay: null,
    model: "",
    modelDisplay: null,
    modeId: "",
    modeDisplay: null,
    thinkingOptionId: "",
    isolation: "",
    extra: {},
  };
}

function roleValue(role: TeamRoleDraft): AgentTeamRoleConfigWire | null {
  const parsed = parseRoleAgent(role.agent);
  if (!parsed) return null;
  const base = {
    ...role.extra,
    description: role.description.trim(),
    ...(role.isolation ? { isolation: role.isolation } : {}),
  };
  if (parsed.kind === "profile") return { ...base, profile: parsed.id };
  return {
    ...base,
    provider: parsed.id,
    ...(role.model ? { model: role.model } : {}),
    ...(role.modeId ? { modeId: role.modeId } : {}),
    ...(role.thinkingOptionId ? { thinkingOptionId: role.thinkingOptionId } : {}),
  };
}

function nameIssue(name: string, taken: ReadonlySet<string>): TeamNameIssue {
  const trimmed = name.trim();
  if (!trimmed) return "required";
  return taken.has(trimmed) ? "duplicate" : null;
}

/**
 * Validation mirrors the daemon's team schema, so a save the form allows is a
 * save the daemon accepts: a name, at least one role, and per role a unique
 * name, a description, and exactly one provider or profile.
 */
export function validateTeamForm(input: {
  name: string;
  roles: readonly TeamRoleDraft[];
  takenTeamNames: ReadonlySet<string>;
}): { nameIssue: TeamNameIssue; roleIssues: Record<string, TeamRoleIssues>; valid: boolean } {
  const teamNameIssue = nameIssue(input.name, input.takenTeamNames);
  const roleIssues: Record<string, TeamRoleIssues> = {};
  const seen = new Set<string>();
  let valid = teamNameIssue === null && input.roles.length > 0;
  for (const role of input.roles) {
    const roleNameIssue = nameIssue(role.name, seen);
    seen.add(role.name.trim());
    const issues: TeamRoleIssues = {
      name: roleNameIssue,
      description: role.description.trim().length === 0,
      agent: parseRoleAgent(role.agent) === null,
    };
    roleIssues[role.key] = issues;
    if (issues.name || issues.description || issues.agent) valid = false;
  }
  return { nameIssue: teamNameIssue, roleIssues, valid };
}

/** The team record the form writes, or null while it is invalid. */
export function buildTeamValue(input: {
  description: string;
  peerMessaging: boolean;
  roles: readonly TeamRoleDraft[];
  extra: Record<string, unknown>;
}): AgentTeamConfigWire | null {
  const roles: Record<string, AgentTeamRoleConfigWire> = {};
  for (const role of input.roles) {
    const value = roleValue(role);
    if (!value) return null;
    roles[role.name.trim()] = value;
  }
  const description = input.description.trim();
  return {
    ...input.extra,
    ...(description ? { description } : {}),
    ...(input.peerMessaging ? { peerMessaging: true } : {}),
    roles,
  };
}

/** Applies one saved team to the host's teams, renaming in place and keeping order. */
export function applyTeamEdit(input: {
  teams: AgentTeamsConfigWire;
  originalName: string | null;
  name: string;
  team: AgentTeamConfigWire;
}): AgentTeamsConfigWire {
  const next: AgentTeamsConfigWire = {};
  let placed = false;
  for (const [name, team] of Object.entries(input.teams)) {
    if (name === input.originalName) {
      next[input.name] = input.team;
      placed = true;
      continue;
    }
    if (name === input.name) continue;
    next[name] = team;
  }
  if (!placed) next[input.name] = input.team;
  return next;
}

export function removeTeam(teams: AgentTeamsConfigWire, name: string): AgentTeamsConfigWire {
  return Object.fromEntries(Object.entries(teams).filter(([entry]) => entry !== name));
}

function refineDisplay(
  current: TeamFormDisplay | null,
  selectedId: string,
  label: string | null,
): TeamFormDisplay | null {
  if (!selectedId) return null;
  if (label) return { label };
  return current ?? { label: selectedId };
}

function refineRoleDisplays(
  role: TeamRoleDraft,
  entries: readonly ProviderSnapshotEntry[],
  profiles: readonly AgentProfile[],
): TeamRoleDraft {
  const parsed = parseRoleAgent(role.agent);
  if (!parsed) return role;
  if (parsed.kind === "profile") {
    const profile = findProfile(profiles, parsed.id);
    // A role that named its profile by name is rewritten to the id on save.
    const agent = profile ? `${PROFILE_PREFIX}${profile.id}` : role.agent;
    return {
      ...role,
      agent,
      agentDisplay: refineDisplay(role.agentDisplay, agent, profile?.name ?? null),
    };
  }
  const entry = findEntry(entries, parsed.id);
  const model = roleModels(entries, role.agent).find((candidate) => candidate.id === role.model);
  const mode = roleModes(entries, role.agent).find((candidate) => candidate.id === role.modeId);
  return {
    ...role,
    agentDisplay: refineDisplay(role.agentDisplay, role.agent, entry?.label ?? null),
    modelDisplay: refineDisplay(role.modelDisplay, role.model, model?.label ?? null),
    modeDisplay: refineDisplay(
      role.modeDisplay,
      role.modeId,
      mode ? formatAgentModeLabel(mode) : null,
    ),
  };
}

function defaultModel(models: readonly AgentModelDefinition[]): AgentModelDefinition | null {
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

export function openTeamForm(snapshot: TeamFormSnapshot): TeamFormModel {
  const listeners = new Set<() => void>();
  let nextKey = 0;
  const makeKey = () => `role-${nextKey++}`;
  const originalName = snapshot.mode === "edit" ? (snapshot.teamName ?? null) : null;
  const takenTeamNames = new Set(
    snapshot.existingTeamNames.filter((name) => name !== originalName),
  );
  const team = snapshot.mode === "edit" ? snapshot.team : undefined;
  const teamExtra = team ? pickExtra(team, KNOWN_TEAM_FIELDS) : {};
  const seededRoles = team
    ? Object.entries(team.roles).map(([name, role]) => seedRole(makeKey(), name, role))
    : [emptyRole(makeKey())];

  function derive(
    base: Omit<
      TeamFormState,
      "agentOptions" | "nameIssue" | "roleIssues" | "canSubmit" | "submitValue"
    >,
  ): TeamFormState {
    const validation = validateTeamForm({ name: base.name, roles: base.roles, takenTeamNames });
    const teamValue = validation.valid
      ? buildTeamValue({
          description: base.description,
          peerMessaging: base.peerMessaging,
          roles: base.roles,
          extra: teamExtra,
        })
      : null;
    return {
      ...base,
      agentOptions: buildAgentOptions(base.entries, base.profiles),
      nameIssue: validation.nameIssue,
      roleIssues: validation.roleIssues,
      canSubmit: teamValue !== null && !base.isSubmitting,
      submitValue: teamValue ? { name: base.name.trim(), team: teamValue } : null,
    };
  }

  let state = derive({
    mode: snapshot.mode,
    originalName,
    name: originalName ?? "",
    description: team?.description ?? "",
    peerMessaging: team?.peerMessaging === true,
    roles: seededRoles,
    entries: [],
    profiles: [],
    isSubmitting: false,
    submitError: null,
  });

  function publish(patch: Partial<TeamFormState>): void {
    state = derive({ ...state, ...patch });
    for (const listener of listeners) listener();
  }

  function updateRole(key: string, update: (role: TeamRoleDraft) => TeamRoleDraft): void {
    publish({ roles: state.roles.map((role) => (role.key === key ? update(role) : role)) });
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => listeners.clear(),
    applyProviderCatalog: (entries) => {
      publish({
        entries,
        roles: state.roles.map((role) => refineRoleDisplays(role, entries, state.profiles)),
      });
    },
    applyProfiles: (profiles) => {
      publish({
        profiles,
        roles: state.roles.map((role) => refineRoleDisplays(role, state.entries, profiles)),
      });
    },
    setName: (name) => publish({ name }),
    setDescription: (description) => publish({ description }),
    setPeerMessaging: (peerMessaging) => publish({ peerMessaging }),
    addRole: () => publish({ roles: [...state.roles, emptyRole(makeKey())] }),
    removeRole: (key) => publish({ roles: state.roles.filter((role) => role.key !== key) }),
    setRoleName: (key, name) => updateRole(key, (role) => ({ ...role, name })),
    setRoleDescription: (key, description) => updateRole(key, (role) => ({ ...role, description })),
    setRoleAgent: (key, agent, display) =>
      updateRole(key, (role) => {
        if (role.agent === agent) return role;
        const parsed = parseRoleAgent(agent);
        const entry = parsed?.kind === "provider" ? findEntry(state.entries, parsed.id) : null;
        const model = defaultModel(roleModels(state.entries, agent));
        const modes = roleModes(state.entries, agent);
        const mode =
          modes.find((candidate) => candidate.id === entry?.defaultModeId) ?? modes[0] ?? null;
        return {
          ...role,
          agent,
          agentDisplay: display,
          model: model?.id ?? "",
          modelDisplay: model ? { label: model.label } : null,
          modeId: mode?.id ?? "",
          modeDisplay: mode ? { label: formatAgentModeLabel(mode) } : null,
          thinkingOptionId: "",
        };
      }),
    setRoleModel: (key, model, display) =>
      updateRole(key, (role) =>
        role.model === model
          ? role
          : { ...role, model, modelDisplay: display, thinkingOptionId: "" },
      ),
    setRoleMode: (key, modeId, display) =>
      updateRole(key, (role) => ({ ...role, modeId, modeDisplay: display })),
    setRoleIsolation: (key, isolation) => updateRole(key, (role) => ({ ...role, isolation })),
    setSubmitting: (isSubmitting) => publish({ isSubmitting }),
    setSubmitError: (submitError) => publish({ submitError }),
  };
}
