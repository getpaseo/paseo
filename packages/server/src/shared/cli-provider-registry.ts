// CLI Provider Registry — external CLI coding agents that can be detected on the host
// Ported from emdash's shared/providers/registry.ts
// These are separate from hubcode's built-in agent providers (claude, codex, copilot, opencode, pi)
import { z } from "zod";

export const CLI_PROVIDER_IDS = [
  "codex",
  "claude",
  "qwen",
  "droid",
  "gemini",
  "cursor",
  "copilot",
  "amp",
  "opencode",
  "hermes",
  "charm",
  "auggie",
  "goose",
  "kimi",
  "kilocode",
  "kiro",
  "rovo",
  "cline",
  "continue",
  "codebuff",
  "mistral",
  "pi",
  "autohand",
  "forge",
] as const;

export type CliProviderId = string;

export const CLI_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface CliProviderDefinition {
  id: CliProviderId;
  name: string;
  docUrl?: string;
  installCommand?: string;
  commands?: string[];
  versionArgs?: string[];
  detectable?: boolean;
  cli?: string;
  autoApproveFlag?: string;
  initialPromptFlag?: string;
  /**
   * When true, the initial prompt is delivered via keystroke injection
   * (typing into the TUI after startup) instead of as a CLI argument.
   */
  useKeystrokeInjection?: boolean;
  resumeFlag?: string;
  sessionIdFlag?: string;
  defaultArgs?: string[];
  planActivateCommand?: string;
  autoStartCommand?: string;
  icon?: string;
  terminalOnly?: boolean;
}

export const CliProviderOverrideSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1).optional(),
    docUrl: z.string().trim().min(1).optional(),
    installCommand: z.string().trim().min(1).optional(),
    versionArgs: z.array(z.string().min(1)).optional(),
    defaultArgs: z.array(z.string()).optional(),
    autoApproveFlag: z.string().optional(),
    initialPromptFlag: z.string().optional(),
    useKeystrokeInjection: z.boolean().optional(),
    resumeFlag: z.string().optional(),
    sessionIdFlag: z.string().optional(),
    planActivateCommand: z.string().optional(),
    autoStartCommand: z.string().optional(),
    detectable: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const CliProviderOverridesSchema = z
  .record(z.string(), CliProviderOverrideSchema)
  .superRefine((providers, ctx) => {
    const builtinProviderIdSet = new Set<string>(CLI_PROVIDER_IDS);

    for (const [providerId, provider] of Object.entries(providers)) {
      if (!CLI_PROVIDER_ID_PATTERN.test(providerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId],
          message: `CLI provider ID "${providerId}" must match ${CLI_PROVIDER_ID_PATTERN}.`,
        });
      }

      const isBuiltinProvider = builtinProviderIdSet.has(providerId);
      if (isBuiltinProvider) {
        continue;
      }

      if (!provider.name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId, "name"],
          message: `Custom CLI provider "${providerId}" must declare name.`,
        });
      }

      if (!provider.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerId, "command"],
          message: `Custom CLI provider "${providerId}" must declare command.`,
        });
      }
    }
  });

export type CliProviderOverride = z.infer<typeof CliProviderOverrideSchema>;
export type CliProviderOverrides = z.infer<typeof CliProviderOverridesSchema>;

export const CLI_PROVIDERS: CliProviderDefinition[] = [
  {
    id: "codex",
    name: "Codex",
    docUrl: "https://github.com/openai/codex",
    installCommand: "npm install -g @openai/codex",
    commands: ["codex"],
    versionArgs: ["--version"],
    cli: "codex",
    autoApproveFlag: "--full-auto",
    initialPromptFlag: "",
    resumeFlag: "resume --last",
    icon: "openai.svg",
    terminalOnly: true,
  },
  {
    id: "claude",
    name: "Claude Code",
    docUrl: "https://docs.anthropic.com/claude/docs/claude-code",
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    commands: ["claude"],
    versionArgs: ["--version"],
    cli: "claude",
    autoApproveFlag: "--dangerously-skip-permissions",
    initialPromptFlag: "",
    resumeFlag: "-c -r",
    sessionIdFlag: "--session-id",
    planActivateCommand: "/plan",
    icon: "claude.png",
    terminalOnly: true,
  },
  {
    id: "cursor",
    name: "Cursor",
    docUrl: "https://cursor.sh",
    installCommand: "curl https://cursor.com/install -fsS | bash",
    commands: ["cursor-agent"],
    versionArgs: ["--version"],
    cli: "cursor-agent",
    autoApproveFlag: "-f",
    initialPromptFlag: "",
    icon: "cursor.svg",
    terminalOnly: true,
  },
  {
    id: "gemini",
    name: "Gemini",
    docUrl: "https://github.com/google-gemini/gemini-cli",
    installCommand: "npm install -g @google/gemini-cli",
    commands: ["gemini"],
    versionArgs: ["--version"],
    cli: "gemini",
    autoApproveFlag: "--yolo",
    initialPromptFlag: "-i",
    resumeFlag: "--resume",
    icon: "gemini.png",
    terminalOnly: true,
  },
  {
    id: "qwen",
    name: "Qwen Code",
    docUrl: "https://github.com/QwenLM/qwen-code",
    installCommand: "npm install -g @qwen-code/qwen-code",
    commands: ["qwen"],
    versionArgs: ["--version"],
    cli: "qwen",
    autoApproveFlag: "--yolo",
    initialPromptFlag: "-i",
    resumeFlag: "--continue",
    icon: "qwen.png",
    terminalOnly: true,
  },
  {
    id: "droid",
    name: "Droid",
    docUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
    installCommand: "curl -fsSL https://app.factory.ai/cli | sh",
    commands: ["droid"],
    versionArgs: ["--version"],
    cli: "droid",
    initialPromptFlag: "",
    resumeFlag: "-r",
    icon: "droid.svg",
    terminalOnly: true,
  },
  {
    id: "amp",
    name: "Amp",
    docUrl: "https://ampcode.com/manual#install",
    installCommand: "npm install -g @sourcegraph/amp@latest",
    commands: ["amp"],
    versionArgs: ["--version"],
    cli: "amp",
    autoApproveFlag: "--dangerously-allow-all",
    initialPromptFlag: "",
    useKeystrokeInjection: true,
    icon: "ampcode.png",
    terminalOnly: true,
  },
  {
    id: "opencode",
    name: "OpenCode",
    docUrl: "https://opencode.ai/docs/cli/",
    installCommand: "npm install -g opencode-ai",
    commands: ["opencode"],
    versionArgs: ["--version"],
    cli: "opencode",
    initialPromptFlag: "",
    useKeystrokeInjection: true,
    icon: "opencode.png",
    terminalOnly: true,
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    docUrl: "https://hermes-agent.nousresearch.com/docs/",
    installCommand:
      "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
    commands: ["hermes"],
    versionArgs: ["version"],
    cli: "hermes",
    initialPromptFlag: "",
    useKeystrokeInjection: true,
    resumeFlag: "--continue",
    icon: "hermesagent.jpg",
    terminalOnly: true,
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    docUrl: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    installCommand: "npm install -g @github/copilot",
    commands: ["copilot"],
    versionArgs: ["--version"],
    cli: "copilot",
    autoApproveFlag: "--allow-all-tools",
    initialPromptFlag: "-i",
    icon: "gh-copilot.svg",
    terminalOnly: true,
  },
  {
    id: "charm",
    name: "Charm",
    docUrl: "https://github.com/charmbracelet/crush",
    installCommand: "npm install -g @charmland/crush",
    commands: ["crush"],
    versionArgs: ["--version"],
    cli: "crush",
    autoApproveFlag: "--yolo",
    icon: "charm.png",
    terminalOnly: true,
  },
  {
    id: "auggie",
    name: "Auggie",
    docUrl: "https://docs.augmentcode.com/cli/overview",
    installCommand: "npm install -g @augmentcode/auggie",
    commands: ["auggie"],
    versionArgs: ["--version"],
    cli: "auggie",
    initialPromptFlag: "",
    defaultArgs: ["--allow-indexing"],
    icon: "Auggie.svg",
    terminalOnly: true,
  },
  {
    id: "goose",
    name: "Goose",
    docUrl: "https://block.github.io/goose/docs/quickstart/",
    installCommand:
      "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash",
    detectable: false,
    cli: "goose",
    defaultArgs: ["run", "-s"],
    initialPromptFlag: "-t",
    icon: "goose.png",
    terminalOnly: true,
  },
  {
    id: "kimi",
    name: "Kimi",
    docUrl: "https://www.kimi.com/code/docs/en/kimi-cli/guides/getting-started.html",
    installCommand: "uv tool install kimi-cli",
    commands: ["kimi"],
    versionArgs: ["--version"],
    cli: "kimi",
    autoApproveFlag: "--yolo",
    initialPromptFlag: "-c",
    icon: "kimi.png",
    terminalOnly: true,
  },
  {
    id: "kilocode",
    name: "Kilocode",
    docUrl: "https://kilo.ai/docs/cli",
    installCommand: "npm install -g @kilocode/cli",
    commands: ["kilocode"],
    versionArgs: ["--version"],
    cli: "kilocode",
    autoApproveFlag: "--auto",
    initialPromptFlag: "",
    resumeFlag: "--continue",
    icon: "kilocode.png",
    terminalOnly: true,
  },
  {
    id: "kiro",
    name: "Kiro (AWS)",
    docUrl: "https://kiro.dev/docs/cli/",
    installCommand: "curl -fsSL https://cli.kiro.dev/install | bash",
    commands: ["kiro-cli"],
    versionArgs: ["--version"],
    cli: "kiro-cli",
    defaultArgs: ["chat"],
    initialPromptFlag: "",
    icon: "kiro.png",
    terminalOnly: true,
  },
  {
    id: "rovo",
    name: "Rovo Dev",
    docUrl: "https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/",
    installCommand: "acli rovodev auth login",
    commands: ["rovodev", "acli"],
    versionArgs: ["--version"],
    autoApproveFlag: "--yolo",
    autoStartCommand: "acli rovodev run",
    icon: "atlassian.png",
    terminalOnly: true,
  },
  {
    id: "cline",
    name: "Cline",
    docUrl: "https://docs.cline.bot/cline-cli/overview",
    installCommand: "npm install -g cline",
    commands: ["cline"],
    versionArgs: ["help"],
    cli: "cline",
    autoApproveFlag: "--yolo",
    initialPromptFlag: "",
    icon: "cline.png",
    terminalOnly: true,
  },
  {
    id: "continue",
    name: "Continue",
    docUrl: "https://docs.continue.dev/guides/cli",
    installCommand: "npm i -g @continuedev/cli",
    commands: ["cn"],
    versionArgs: ["--version"],
    cli: "cn",
    initialPromptFlag: "-p",
    resumeFlag: "--resume",
    icon: "continue.png",
    terminalOnly: true,
  },
  {
    id: "codebuff",
    name: "Codebuff",
    docUrl: "https://www.codebuff.com/docs/help/quick-start",
    installCommand: "npm install -g codebuff",
    commands: ["codebuff"],
    versionArgs: ["--version"],
    cli: "codebuff",
    initialPromptFlag: "",
    icon: "codebuff.png",
    terminalOnly: true,
  },
  {
    id: "mistral",
    name: "Mistral Vibe",
    docUrl: "https://github.com/mistralai/mistral-vibe",
    installCommand: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
    commands: ["vibe"],
    versionArgs: ["-h"],
    cli: "vibe",
    autoApproveFlag: "--auto-approve",
    initialPromptFlag: "--prompt",
    icon: "mistral.png",
    terminalOnly: true,
  },
  {
    id: "pi",
    name: "Pi",
    docUrl: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
    installCommand: "npm install -g @mariozechner/pi-coding-agent",
    commands: ["pi"],
    versionArgs: ["--version"],
    cli: "pi",
    initialPromptFlag: "",
    resumeFlag: "-c",
    icon: "pi.png",
    terminalOnly: true,
  },
  {
    id: "autohand",
    name: "Autohand Code",
    docUrl: "https://autohand.ai/code/",
    installCommand: "npm install -g autohand-cli",
    commands: ["autohand"],
    versionArgs: ["--version"],
    cli: "autohand",
    autoApproveFlag: "--unrestricted",
    initialPromptFlag: "-p",
    icon: "autohand.svg",
    terminalOnly: true,
  },
  {
    id: "forge",
    name: "Forge",
    docUrl: "https://forgecode.dev/docs/",
    installCommand: "curl -fsSL https://forgecode.dev/cli | sh",
    commands: ["forge"],
    versionArgs: ["--version"],
    cli: "forge",
    initialPromptFlag: "-p",
    resumeFlag: "--conversation-id",
    icon: "forge.svg",
    terminalOnly: true,
  },
];

const CLI_PROVIDER_MAP = new Map<string, CliProviderDefinition>(
  CLI_PROVIDERS.map((provider) => [provider.id, provider]),
);

function normalizeProviderDefinition(
  providerId: string,
  base: CliProviderDefinition | undefined,
  override: CliProviderOverride | undefined,
): CliProviderDefinition | null {
  if (!base && !override) {
    return null;
  }

  const command = override?.command?.trim();
  const commands = command ? [command] : (base?.commands ?? (base?.cli ? [base.cli] : []));
  const cli = command ?? base?.cli ?? commands[0];
  const enabled = override?.enabled ?? true;

  if (!enabled) {
    return null;
  }

  return {
    ...(base ?? {}),
    id: providerId,
    name: override?.name ?? base?.name ?? providerId,
    docUrl: override?.docUrl ?? base?.docUrl,
    installCommand: override?.installCommand ?? base?.installCommand,
    commands,
    versionArgs: override?.versionArgs ?? base?.versionArgs,
    detectable: override?.detectable ?? base?.detectable ?? true,
    cli,
    autoApproveFlag: override?.autoApproveFlag ?? base?.autoApproveFlag,
    initialPromptFlag: override?.initialPromptFlag ?? base?.initialPromptFlag,
    useKeystrokeInjection: override?.useKeystrokeInjection ?? base?.useKeystrokeInjection,
    resumeFlag: override?.resumeFlag ?? base?.resumeFlag,
    sessionIdFlag: override?.sessionIdFlag ?? base?.sessionIdFlag,
    defaultArgs: override?.defaultArgs ?? base?.defaultArgs,
    planActivateCommand: override?.planActivateCommand ?? base?.planActivateCommand,
    autoStartCommand: override?.autoStartCommand ?? base?.autoStartCommand,
    icon: base?.icon,
    terminalOnly: true,
  };
}

export function isBuiltInCliProviderId(id: string): boolean {
  return CLI_PROVIDER_MAP.has(id);
}

export function listCliProviders(options?: {
  overrides?: CliProviderOverrides | null;
  includeDisabled?: boolean;
}): CliProviderDefinition[] {
  const overrides = options?.overrides ?? {};
  const includeDisabled = options?.includeDisabled ?? false;
  const providers: CliProviderDefinition[] = [];

  for (const provider of CLI_PROVIDERS) {
    const override = overrides[provider.id];
    if (override?.enabled === false && !includeDisabled) {
      continue;
    }

    const resolved = normalizeProviderDefinition(provider.id, provider, override);
    if (!resolved && includeDisabled) {
      providers.push({
        ...provider,
        commands: provider.commands ?? (provider.cli ? [provider.cli] : []),
      });
      continue;
    }
    if (resolved) {
      providers.push(resolved);
    }
  }

  for (const [providerId, override] of Object.entries(overrides)) {
    if (CLI_PROVIDER_MAP.has(providerId)) {
      continue;
    }
    if (override.enabled === false && !includeDisabled) {
      continue;
    }

    const resolved = normalizeProviderDefinition(providerId, undefined, override);
    if (!resolved && includeDisabled) {
      providers.push({
        id: providerId,
        name: override.name ?? providerId,
        commands: override.command ? [override.command] : [],
        cli: override.command,
        docUrl: override.docUrl,
        installCommand: override.installCommand,
        versionArgs: override.versionArgs,
        defaultArgs: override.defaultArgs,
        autoApproveFlag: override.autoApproveFlag,
        initialPromptFlag: override.initialPromptFlag,
        useKeystrokeInjection: override.useKeystrokeInjection,
        resumeFlag: override.resumeFlag,
        sessionIdFlag: override.sessionIdFlag,
        planActivateCommand: override.planActivateCommand,
        autoStartCommand: override.autoStartCommand,
        detectable: override.detectable ?? true,
        terminalOnly: true,
      });
      continue;
    }
    if (resolved) {
      providers.push(resolved);
    }
  }

  return providers;
}

export function getCliProvider(
  id: CliProviderId,
  overrides?: CliProviderOverrides | null,
): CliProviderDefinition | undefined {
  return listCliProviders({ overrides, includeDisabled: true }).find(
    (provider) => provider.id === id,
  );
}

export function getCliProviderInstallCommand(
  id: CliProviderId,
  overrides?: CliProviderOverrides | null,
): string | null {
  return getCliProvider(id, overrides)?.installCommand ?? null;
}

export function isValidCliProviderId(
  value: unknown,
  overrides?: CliProviderOverrides | null,
): value is CliProviderId {
  return typeof value === "string" && getCliProvider(value, overrides) !== undefined;
}

export function listDetectableCliProviders(
  overrides?: CliProviderOverrides | null,
): CliProviderDefinition[] {
  return listCliProviders({ overrides }).filter(
    (provider) => provider.detectable !== false && provider.commands?.length,
  );
}

export function buildCliAgentArgs(
  options: {
    providerId: CliProviderId;
    autoApprove?: boolean;
    initialPrompt?: string;
    resume?: boolean;
    extraArgs?: string[];
  },
  overrides?: CliProviderOverrides | null,
): string[] {
  const provider = getCliProvider(options.providerId, overrides);
  if (!provider) {
    return [];
  }

  const args: string[] = [];

  if (options.resume && provider.resumeFlag) {
    args.push(...provider.resumeFlag.split(" "));
  }

  if (provider.defaultArgs) {
    args.push(...provider.defaultArgs);
  }

  if (options.autoApprove && provider.autoApproveFlag) {
    args.push(provider.autoApproveFlag);
  }

  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  if (options.initialPrompt && provider.initialPromptFlag !== undefined) {
    if (provider.initialPromptFlag) {
      args.push(provider.initialPromptFlag, options.initialPrompt);
    } else if (!provider.useKeystrokeInjection) {
      args.push(options.initialPrompt);
    }
  }

  return args;
}
