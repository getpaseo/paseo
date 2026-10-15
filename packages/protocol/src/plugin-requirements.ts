import type { PluginRequirements } from "./messages.js";
import validRange from "semver/ranges/valid.js";

export function validatePluginRequirements(requirements: PluginRequirements | undefined): void {
  const range = requirements?.paseo;
  if (range !== undefined && (!range.trim() || validRange(range) === null)) {
    throw new Error(
      `Invalid requirements.paseo: ${JSON.stringify(range)}. Use an npm semver range such as ">=0.8.0".`,
    );
  }
}

interface PluginCompatibilityInput {
  id: string;
  requirements?: PluginRequirements;
  version: string | null;
  runtime: "daemon" | "app";
}

export function assertPluginCompatibility(input: PluginCompatibilityInput): void {
  validatePluginRequirements(input.requirements);
}
