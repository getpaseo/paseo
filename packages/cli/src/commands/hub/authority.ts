import type { HubCredentialStore } from "./credentials.js";
import { HubCommandError } from "./error.js";
import { normalizeHubOrigin } from "./origin.js";

export interface HubAuthorityOptions {
  origin?: string;
  apiKey?: string;
}

export interface HubAuthority {
  origin: string;
  credential: string;
}

interface ResolveHubAuthorityInput {
  options: HubAuthorityOptions;
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
}

export function resolveHubAuthority(input: ResolveHubAuthorityInput): HubAuthority {
  const configuredOrigin = input.options.origin ?? input.env.PASEO_HUB_URL;
  const selectedOrigin = configuredOrigin ?? input.credentials.active()?.origin;
  if (selectedOrigin === undefined) {
    throw new HubCommandError(
      "HUB_ORIGIN_REQUIRED",
      "Hub origin is required. Pass --hub <origin>, set PASEO_HUB_URL, or run `paseo hub login <origin>`.",
    );
  }
  const origin = normalizeHubOrigin(selectedOrigin);
  const explicitCredential = input.options.apiKey ?? input.env.PASEO_HUB_API_KEY;
  if (explicitCredential !== undefined) return { origin, credential: explicitCredential };
  const stored = input.credentials.get(origin);
  if (stored !== null) return { origin, credential: stored.credential };
  throw new HubCommandError(
    "HUB_API_KEY_REQUIRED",
    `No stored Hub login matches ${origin}. Pass --api-key <secret>, set PASEO_HUB_API_KEY, or run \`paseo hub login ${origin}\`.`,
  );
}
