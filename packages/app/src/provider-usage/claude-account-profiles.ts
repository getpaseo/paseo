import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

export interface ClaudeAccountProfile {
  providerId: string;
  label: string;
  configDir: string;
}

export function listClaudeAccountProfiles(
  config: MutableDaemonConfig | null,
): ClaudeAccountProfile[] {
  if (!config) return [];
  return Object.entries(config.providers).flatMap(([providerId, value]) => {
    const provider = value as Record<string, unknown>;
    if (provider["extends"] !== "claude") return [];
    const env = provider["env"];
    if (!env || typeof env !== "object" || Array.isArray(env)) return [];
    const configDir = (env as Record<string, unknown>)["CLAUDE_CONFIG_DIR"];
    if (typeof configDir !== "string" || configDir.trim().length === 0) return [];
    const label = provider["label"];
    return [
      {
        providerId,
        label: typeof label === "string" && label.trim().length > 0 ? label.trim() : providerId,
        configDir: configDir.trim(),
      },
    ];
  });
}

export function buildClaudeAccountPatch(input: {
  label: string;
  configDir: string;
  existingProviderIds: readonly string[];
}): MutableDaemonConfigPatch {
  const label = input.label.trim();
  const configDir = input.configDir.trim();
  const providerId = nextProviderId(label, new Set(input.existingProviderIds));
  return {
    providers: {
      [providerId]: {
        extends: "claude",
        label,
        description: `Claude account using ${configDir}`,
        env: { CLAUDE_CONFIG_DIR: configDir },
        params: { paseoClaudeAccount: true },
        enabled: true,
      },
    },
  };
}

export function isAbsoluteHostPath(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(trimmed);
}

function nextProviderId(label: string, existingIds: ReadonlySet<string>): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "account";
  const base = `claude-${slug}`;
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}
