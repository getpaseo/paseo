import type { CommandError } from "../output/index.js";

export interface ResolveProviderAndModelOptions {
  provider?: string;
  model?: string;
  defaultProvider?: string;
}

export interface ResolvedProviderModel {
  provider: string;
  model: string | undefined;
}

export function resolveProviderAndModel(
  options: ResolveProviderAndModelOptions,
): ResolvedProviderModel {
  const providerInput = options.provider?.trim() || options.defaultProvider || "claude";
  const modelInput = options.model?.trim();

  if (options.model !== undefined && !modelInput) {
    const error: CommandError = {
      code: "INVALID_MODEL",
      message: "--model cannot be empty",
    };
    throw error;
  }

  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return {
      provider: providerInput,
      model: modelInput,
    };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const modelFromProvider = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !modelFromProvider) {
    const error: CommandError = {
      code: "INVALID_PROVIDER",
      message: "Invalid --provider value",
      details: "Use --provider <provider> or --provider <provider>/<model>",
    };
    throw error;
  }

  if (modelInput && modelInput !== modelFromProvider) {
    const error: CommandError = {
      code: "CONFLICTING_MODEL_OPTIONS",
      message: "Conflicting model values provided",
      details: `--provider specifies model ${modelFromProvider}, but --model specifies ${modelInput}`,
    };
    throw error;
  }

  return {
    provider,
    model: modelInput ?? modelFromProvider,
  };
}
