import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";

export type BuiltinProviderIconName = "claude" | "codex" | "copilot" | "kiro" | "opencode" | "pi";

export type ProviderIconName =
  | { kind: "builtin"; id: BuiltinProviderIconName }
  | { kind: "catalog"; id: string }
  | { kind: "bot" };

const BUILTIN_PROVIDER_IDS: ReadonlySet<BuiltinProviderIconName> = new Set([
  "claude",
  "codex",
  "copilot",
  "kiro",
  "opencode",
  "pi",
]);

const CATALOG_ICON_PROVIDER_IDS: ReadonlySet<string> = new Set(
  ACP_PROVIDER_CATALOG.flatMap((entry) => (entry.iconSvg ? [entry.id] : [])),
);

export function resolveProviderIconName(provider: string): ProviderIconName {
  if (BUILTIN_PROVIDER_IDS.has(provider as BuiltinProviderIconName)) {
    return { kind: "builtin", id: provider as BuiltinProviderIconName };
  }
  if (CATALOG_ICON_PROVIDER_IDS.has(provider)) {
    return { kind: "catalog", id: provider };
  }
  return { kind: "bot" };
}
