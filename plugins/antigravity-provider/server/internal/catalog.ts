import type {
  ProviderCatalog,
  ProviderLaunch,
  ProviderModel,
  ProviderMode,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { probe } from "./process.js";
import { AntigravityError } from "./wire.js";

const modes: readonly ProviderMode[] = [
  {
    id: "full-access",
    icon: "ShieldOff",
    colorTier: "dangerous",
    label: "Full access",
    description:
      "Antigravity cannot ask for permission when another app drives it. Paseo starts it with --dangerously-skip-permissions.",
    isUnattended: true,
  },
];

export async function getCatalog(launch: ProviderLaunch, cwd?: string): Promise<ProviderCatalog> {
  const output = await probe({ launch, args: ["models"], cwd });
  const models: ProviderModel[] = [];
  for (const rawLine of output.trim().split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [id, label, ...extra] = rawLine.split("\t");
    if (!id || !label || extra.length > 0)
      throw new AntigravityError("Invalid `agy models` output", "INVALID_CATALOG");
    if (models.some((model) => model.id === id))
      throw new AntigravityError(`Duplicate Antigravity model: ${id}`, "INVALID_CATALOG");
    models.push({ id, label });
  }
  return { models, modes, thinkingOptions: [], defaultMode: "full-access" };
}

export async function getStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  try {
    const version = (await probe({ launch, args: ["--version"] })).trim();
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match)
      return {
        available: false,
        diagnostic: "Could not read the Antigravity version. Update `agy` to 1.1.15 or later.",
      };
    const [, major, minor, patch] = match.map(Number);
    const supported = major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 15)));
    if (!supported)
      return {
        available: false,
        diagnostic: `Antigravity ${version} is unsupported. Update \`agy\` to 1.1.15 or later.`,
      };
    await getCatalog(launch);
    return { available: true };
  } catch (error) {
    if (!(error instanceof AntigravityError)) throw error;
    return { available: false, diagnostic: error.message };
  }
}

export function normalizeModelId(
  model: string | undefined,
  catalog: ProviderCatalog,
): string | undefined {
  if (!model) return undefined;
  if (catalog.models.some((m) => m.id === model)) return model;

  const match = /^(.*)-(low|medium|high|xhigh|max)$/.exec(model);
  if (match) {
    const candidate = `antigravity/${match[1]}:${match[2]}`;
    if (catalog.models.some((m) => m.id === candidate)) return candidate;
  }

  const scopedMatch = /^antigravity\/(.*):(low|medium|high|xhigh|max)$/.exec(model);
  if (scopedMatch) {
    const candidate = `${scopedMatch[1]}-${scopedMatch[2]}`;
    if (catalog.models.some((m) => m.id === candidate)) return candidate;
  }

  return model;
}

export function validateSelection(
  config: { model?: string; mode?: string; thinkingOption?: string },
  catalog: ProviderCatalog,
): void {
  if (config.model) {
    const resolved = normalizeModelId(config.model, catalog);
    if (!catalog.models.some((model) => model.id === resolved))
      throw new AntigravityError(`Unknown Antigravity model: ${config.model}`, "INVALID_MODEL");
  }
  if (config.mode && !catalog.modes.some((mode) => mode.id === config.mode))
    throw new AntigravityError(`Unknown Antigravity mode: ${config.mode}`, "INVALID_MODE");
  if (config.thinkingOption)
    throw new AntigravityError(
      "Antigravity effort is selected through the model ID",
      "UNSUPPORTED_THINKING",
    );
}
