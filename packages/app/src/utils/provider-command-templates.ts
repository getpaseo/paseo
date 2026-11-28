import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";

export type ProviderCommandId = "resume";

// These templates take provider-native session IDs, not Paseo agent IDs.
export const PROVIDER_COMMAND_TEMPLATES: Record<
  string,
  Partial<Record<ProviderCommandId, readonly string[]>>
> = {
  codex: {
    resume: ["codex", "resume", "{sessionId}"],
  },
  claude: {
    resume: ["claude", "--resume", "{sessionId}"],
  },
  hermes: {
    resume: ["hermes", "--resume", "{sessionId}"],
  },
  pi: {
    resume: ["pi", "--session", "{sessionId}"],
  },
  omp: {
    resume: ["omp", "--session", "{sessionId}"],
  },
  opencode: {
    resume: ["opencode", "--session", "{sessionId}"],
  },
};

const ProviderCommandOverrideSchema = ProviderOverrideSchema.pick({
  extends: true,
  command: true,
  env: true,
});

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? "");
}

interface BuildProviderCommandInput {
  provider: string;
  id: ProviderCommandId;
  sessionId: string;
  cwd?: string;
  providers?: Readonly<Record<string, unknown>>;
}

function quoteShellArgument(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function buildProviderCommand(input: BuildProviderCommandInput): string | null {
  // The command runs on the agent host, which may use a different OS than the client.
  const windowsHost = /^[a-zA-Z]:[\\/]|^\\\\/.test(input.cwd ?? "");
  let provider = input.provider;
  let template: readonly string[] | null = null;
  let command: string[] | undefined;
  const env = new Map<string, string>();
  const visited = new Set<string>();

  // Walk from the selected profile to its native CLI. Child overrides win,
  // matching the daemon's provider inheritance.
  while (!visited.has(provider)) {
    visited.add(provider);
    const override = ProviderCommandOverrideSchema.parse(input.providers?.[provider] ?? {});
    command ??= override.command;
    for (const [key, value] of Object.entries(override.env ?? {})) {
      if (!env.has(key)) {
        env.set(key, value);
      }
    }
    template = PROVIDER_COMMAND_TEMPLATES[provider]?.[input.id] ?? null;
    if (template || !override.extends) {
      break;
    }
    provider = override.extends;
  }

  if (!template) {
    return null;
  }
  // POSIX env/argv rendering is not a valid Windows launch command.
  const configuredLaunch = command !== undefined || env.size > 0;
  if (windowsHost && configuredLaunch) {
    return null;
  }
  const prefix = command ?? template.slice(0, 1);
  const args = template.slice(1).map((arg) => renderTemplate(arg, { sessionId: input.sessionId }));
  const argv = [...prefix, ...args];
  const envArgs = Array.from(env, ([key, value]) => key + "=" + value);
  const envPrefix = envArgs.length > 0 ? ["env", "--", ...envArgs] : [];
  return [...envPrefix, ...argv].map(quoteShellArgument).join(" ");
}
