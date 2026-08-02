import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";

/** Mirrors the id pattern enforced by ProviderOverridesSchema in the protocol. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const BUILTIN_PROVIDER_ID_SET = new Set<string>(BUILTIN_PROVIDER_IDS);

/** Built-in providers plus the generic ACP base. */
export const VALID_EXTENDS_VALUES: string[] = [...BUILTIN_PROVIDER_IDS, "acp"];

export function isBuiltinProviderId(id: string): boolean {
  return BUILTIN_PROVIDER_ID_SET.has(id);
}
