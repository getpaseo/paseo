import type { PluginRequirements } from "./messages.js";
import valid from "semver/functions/valid.js";
import validRange from "semver/ranges/valid.js";
import satisfies from "semver/functions/satisfies.js";

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
  // COMPAT(plugin-requirements): added in v0.8.0; remove after 2027-03-07 once pre-0.8 plugins and catalogs are unsupported.
  const range = input.requirements?.paseo ?? "<0.8.0";
  if (!input.version || !valid(input.version)) {
    throw new Error(
      `Cannot check plugin "${input.id}" requirements: Paseo ${input.runtime} version is unknown. Update the ${input.runtime}.`,
    );
  }
  if (satisfies(input.version, range)) return;
  const action =
    input.requirements?.paseo === undefined
      ? "This plugin has no requirements.paseo and targets Paseo before 0.8. Ask its author to migrate it: https://paseo.sh/docs/plugins/v0.8/migration"
      : `Use a compatible plugin version or update the ${input.runtime}.`;
  throw new Error(
    `Plugin "${input.id}" requires Paseo ${range}. Your ${input.runtime} is ${input.version}. ${action}`,
  );
}
