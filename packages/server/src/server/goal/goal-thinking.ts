import type { AgentModelDefinition } from "../agent/agent-sdk-types.js";

/** The selectable models of a provider, as its catalog reports them for a directory. */
export type GoalModelCatalog = (provider: string, cwd: string) => Promise<AgentModelDefinition[]>;

export class GoalThinkingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalThinkingError";
  }
}

interface ThinkingCheck {
  catalog: GoalModelCatalog | undefined;
  /** `provider` or `provider/model`. */
  providerValue: string;
  thinking: string;
  cwd: string;
  /** What to call the setting in the error, e.g. `leadThinking`. */
  field: string;
}

/**
 * Rejects a thinking option the model's catalog does not list. When the catalog cannot
 * be read, or does not know the model, the id is accepted and the provider decides when
 * the agent starts: a goal is not refused over a catalog that is still loading.
 */
export async function assertThinkingOption(check: ThinkingCheck): Promise<void> {
  if (!check.catalog) return;
  const slash = check.providerValue.indexOf("/");
  const provider = slash < 0 ? check.providerValue : check.providerValue.slice(0, slash);
  const requested = slash < 0 ? undefined : check.providerValue.slice(slash + 1);
  let models: AgentModelDefinition[];
  try {
    models = await check.catalog(provider, check.cwd);
  } catch {
    return;
  }
  const model = requested
    ? models.find((m) => m.id === requested || m.aliases?.includes(requested))
    : (models.find((m) => m.isDefault) ?? models[0]);
  if (!model) return;
  const options = (model.thinkingOptions ?? []).map((option) => option.id);
  if (options.includes(check.thinking)) return;
  throw new GoalThinkingError(
    `${check.field} "${check.thinking}" is not a thinking option of ${provider}/${model.id}. ` +
      `Available: ${options.join(", ") || "(none)"}`,
  );
}

/** Spreads a thinking id into a create input; nothing when the model's default applies. */
export function thinkingInput(thinking: string | undefined): { thinking?: string } {
  return thinking ? { thinking } : {};
}
