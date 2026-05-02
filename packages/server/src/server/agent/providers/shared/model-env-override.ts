import type { AgentModelDefinition } from "../../agent-sdk-types.js";

export interface ModelEnvMapping {
  readonly env: string;
  // When set, the env's value becomes the catalog's default model. The catalog
  // itself is NOT collapsed — other replacements (family/standalone) still apply.
  // This matches Claude Code's `ANTHROPIC_MODEL` semantics: a "global default
  // route" that doesn't suppress more specific `ANTHROPIC_DEFAULT_*_MODEL`
  // replacements.
  readonly globalDefault?: boolean;
  // When set, every built-in model whose ID matches this family is removed and
  // the env's value is injected as the replacement.
  readonly family?: string;
  readonly thinkingOptions?: ReadonlyArray<{ id: string; label: string }>;
}

// Resolves env-based catalog overrides with three layered semantics:
//
//   1. `family` (e.g. ANTHROPIC_DEFAULT_SONNET_MODEL): replace every built-in
//      model in that family with the configured one.
//   2. Standalone — no `family`, no `globalDefault` (e.g. ANTHROPIC_SMALL_FAST_MODEL):
//      append without disturbing built-ins.
//   3. `globalDefault` (e.g. ANTHROPIC_MODEL): the env's value is added (if not
//      already present) and becomes the catalog default. Other family/standalone
//      injections still happen — the catalog is NOT collapsed to a single entry.
//
// Default-flag priority (highest first):
//   a. `globalDefault` env, if set.
//   b. Family-replacement that consumed the previous default.
//   c. Previous built-in default (untouched).
//   d. First remaining model (last-resort safeguard).
export function applyModelEnvOverrides(
  models: AgentModelDefinition[],
  env: Record<string, string | undefined>,
  mappings: readonly ModelEnvMapping[],
): AgentModelDefinition[] {
  let result = models.map((model) => ({ ...model }));
  const previousDefaultId = result.find((m) => m.isDefault)?.id;

  result = replaceFamilies(result, env, mappings);
  injectExtraModels(result, env, mappings);
  applyDefaultModel(result, env, mappings, previousDefaultId);

  return result;
}

function replaceFamilies(
  result: AgentModelDefinition[],
  env: Record<string, string | undefined>,
  mappings: readonly ModelEnvMapping[],
): AgentModelDefinition[] {
  let next = result;
  for (const mapping of mappings) {
    if (!mapping.family) continue;
    const modelId = readEnv(env, mapping.env);
    if (!modelId) continue;
    next = next.filter((m) => !matchesFamily(m.id, mapping.family!));
    ensureModel(next, modelId, mapping.thinkingOptions);
  }
  return next;
}

// Injects every non-family mapping (standalone + globalDefault). Whether the
// model becomes the catalog default is decided later in `applyDefaultModel`.
function injectExtraModels(
  result: AgentModelDefinition[],
  env: Record<string, string | undefined>,
  mappings: readonly ModelEnvMapping[],
): void {
  for (const mapping of mappings) {
    if (mapping.family) continue;
    const modelId = readEnv(env, mapping.env);
    if (!modelId) continue;
    ensureModel(result, modelId, mapping.thinkingOptions);
  }
}

function applyDefaultModel(
  result: AgentModelDefinition[],
  env: Record<string, string | undefined>,
  mappings: readonly ModelEnvMapping[],
  previousDefaultId: string | undefined,
): void {
  // Priority a: explicit globalDefault env wins outright.
  for (const mapping of mappings) {
    if (!mapping.globalDefault) continue;
    const modelId = readEnv(env, mapping.env);
    if (!modelId) continue;
    setDefault(result, modelId);
    return;
  }

  // Priority b: previous default sat in a family that was just replaced —
  // hand the flag to that family's replacement.
  if (previousDefaultId) {
    for (const mapping of mappings) {
      if (!mapping.family) continue;
      const modelId = readEnv(env, mapping.env);
      if (!modelId) continue;
      if (!matchesFamily(previousDefaultId, mapping.family)) continue;
      setDefault(result, modelId);
      return;
    }
  }

  // Priority c: previous default is still in the catalog — nothing to do.
  if (result.some((m) => m.isDefault)) return;

  // Priority d: catalog has no default at all (e.g. all built-ins removed and
  // no globalDefault provided). Promote the first model so consumers always
  // have a sane default.
  if (result.length > 0) result[0]!.isDefault = true;
}

function setDefault(result: AgentModelDefinition[], modelId: string): void {
  for (const m of result) {
    m.isDefault = m.id === modelId;
  }
}

// If the model already exists we deliberately keep its existing `thinkingOptions` —
// the env-based mapping only seeds defaults for models we are introducing.
function ensureModel(
  result: AgentModelDefinition[],
  modelId: string,
  thinkingOptions: ReadonlyArray<{ id: string; label: string }> | undefined,
): void {
  if (result.some((m) => m.id === modelId)) return;
  const entry: AgentModelDefinition = {
    provider: "claude",
    id: modelId,
    label: modelId,
    ...(thinkingOptions ? { thinkingOptions: [...thinkingOptions] } : {}),
  };
  result.push(entry);
}

function readEnv(env: Record<string, string | undefined>, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Segment-based family match — guards against future model IDs where the family
// name appears inside another token (e.g. "octopus" containing "opus").
// Claude IDs follow `claude-{family}-{major}-{minor}` so `-` boundaries are reliable.
function matchesFamily(modelId: string, family: string): boolean {
  return new RegExp(`(^|-)${escapeRegex(family)}(-|$|\\[)`, "i").test(modelId);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
