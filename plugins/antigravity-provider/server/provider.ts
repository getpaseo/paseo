import { stat } from "node:fs/promises";
import { execCommand } from "@getpaseo/plugin/server";
import { runAcpProvider, type AcpTransformer } from "@getpaseo/plugin/server/acp";
import type {
  ProviderInstallationLaunch,
  ProviderLaunch,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { mapToolCall } from "./tool-calls.js";

const legacySession = z.object({
  version: z.literal(1),
  data: z.object({ conversationId: z.string().min(1) }),
});
const systemPromptCapability = z.object({
  antigravity: z.object({ systemPrompt: z.object({ append: z.literal(true) }) }),
});

// agy 1.5.13 advertises these built-in commands and its invocable skills in one ACP list.
const builtInCommands = new Set([
  "goal",
  "compact",
  "schedule",
  "browser",
  "plan",
  "grill-me",
  "teamwork",
  "learn",
  "boost",
]);

const antigravity: AcpTransformer = {
  command(command) {
    return { ...command, kind: builtInCommands.has(command.name) ? "command" : "skill" };
  },
  toolCall: mapToolCall,
  sessionOpen({ persistence, systemPrompt, agentMetadata }) {
    // COMPAT(antigravityStreamJson): added in v0.16.2, remove after 2027-11-19.
    const saved = legacySession.safeParse(persistence);
    return {
      sessionId: saved.success ? saved.data.data.conversationId : undefined,
      metadata:
        systemPrompt && systemPromptCapability.safeParse(agentMetadata).success
          ? { antigravity: { systemPrompt: { append: systemPrompt } } }
          : undefined,
    };
  },
  async configure(change, { apply, catalog }) {
    // COMPAT(antigravityStreamJson): added in v0.16.2, remove after 2027-11-19.
    if (change.target === "model" && change.value) {
      const legacyModel = /^(.*)-(xhigh|high|medium|low|minimal)$/.exec(change.value);
      if (legacyModel) {
        const { models } = catalog();
        const [, model, effort] = legacyModel;
        if (
          !models.some((option) => option.id === change.value) &&
          models.some((option) => option.id === model)
        ) {
          await apply({ target: "model", value: model });
          if (catalog().thinkingOptions?.some((option) => option.id === effort)) {
            await apply({ target: "thinking", value: effort });
          }
          return "handled";
        }
      }
    }
    return "pass";
  },
};

const MIN_AGY_VERSION = [1, 5, 1] as const;
const MIN_AGY_VERSION_LABEL = "1.5.1";
const VERSION_CACHE_LIMIT = 32;

const agyVersionCache = new Map<string, string | undefined>();
const agyVersionInFlight = new Map<string, Promise<string | undefined>>();

function parseSemverTriplet(version: string): readonly [number, number, number] | null {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index]! !== minimum[index]!) return actual[index]! > minimum[index]!;
  }
  return true;
}

async function statSignature(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

async function agyVersionCacheKey(
  launch: Pick<ProviderLaunch, "command" | "args">,
  prefix: readonly string[],
): Promise<string | null> {
  const binarySignature = await statSignature(launch.command);
  if (!binarySignature) return null;
  // Wrappers or test harnesses may invoke `[node, script.cjs, "acp"]`; include the script stat
  // when the first prefix arg points to an existing file so edits invalidate the cache.
  const scriptSignature = prefix[0] ? await statSignature(prefix[0]) : null;
  return JSON.stringify([launch.command, binarySignature, prefix, scriptSignature]);
}

/** The release `agy --version` reports, or its first line when it names no release. */
async function readAgyVersion(
  launch: Pick<ProviderInstallationLaunch, "command" | "args" | "env">,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // The launch ends with the `acp` subcommand and its flags; the version comes from the CLI itself.
  const acp = launch.args.indexOf("acp");
  const prefix = acp === -1 ? launch.args : launch.args.slice(0, acp);
  const cacheKey = await agyVersionCacheKey(launch, prefix);
  if (cacheKey !== null) {
    if (agyVersionCache.has(cacheKey)) {
      return agyVersionCache.get(cacheKey);
    }
    const existing = agyVersionInFlight.get(cacheKey);
    if (existing) return existing;
  }
  const run = execCommand(launch.command, [...prefix, "--version"], {
    env: launch.env,
    timeout: 5000,
    maxBuffer: 8192,
    signal,
  }).then(({ stdout }) => {
    const firstLine = stdout.trim().split("\n")[0]?.trim();
    const version = /\b\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? (firstLine || undefined);
    if (cacheKey !== null) {
      if (agyVersionCache.size >= VERSION_CACHE_LIMIT) agyVersionCache.clear();
      agyVersionCache.set(cacheKey, version);
    }
    return version;
  });
  if (cacheKey !== null) {
    agyVersionInFlight.set(cacheKey, run);
    try {
      return await run;
    } finally {
      if (agyVersionInFlight.get(cacheKey) === run) agyVersionInFlight.delete(cacheKey);
    }
  }
  return run;
}

// agy 1.5.14 reads its sign-in from a token file when any of these is set, and from the OS keyring
// otherwise. https://github.com/google-antigravity/antigravity-cli/issues/1336
const sshSessionVariables = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

/**
 * Report rows that say whether agy runs in an SSH session, because that decides which sign-in it
 * uses. The report does not wrap, so each row stays short enough to read without scrolling.
 */
function describeSignIn(env: Readonly<Record<string, string>>): string {
  const variable = sshSessionVariables.find((name) => env[name]);
  return variable
    ? `SSH session: yes (${variable})\nSign-in: can differ from agy outside SSH`
    : "SSH session: no\nSign-in: can differ from agy over SSH";
}

export function createAntigravityProvider(): ProviderRegistration {
  const provider = runAcpProvider({
    id: "antigravity",
    label: "Antigravity",
    description: "Antigravity CLI on your host",
    icon: "icon.svg",
    command: ["agy", "acp"],
    acpOptions: {
      // agy 1.5.14 lists thinking options for the selected model only, and none for Orchestrator.
      perModelThinkingOptions: true,
      waitForInitialCommands: true,
      loadReplayQuietPeriodMs: 200,
      // COMPAT(antigravityAcpV1DeferredTurn): added in v0.18.0, remove once Antigravity CLI supports ACP v2 state_update.
      deferTurnOnRunningTools: {
        keepsTurnOpen(toolCall) {
          const input = toolCall.input;
          if (typeof input !== "object" || input === null || Array.isArray(input)) return true;
          if (input.IsDaemon === true) return false;

          // agy leaves recurring schedules in progress after registering them.
          const recurringSchedule =
            toolCall.name === "schedule" &&
            typeof input.CronExpression === "string" &&
            input.CronExpression.trim().length > 0;
          return !recurringSchedule;
        },
      },
      autoAcceptMode: {
        mode: {
          id: "full-access",
          label: "Full access",
          description: "Approve tool requests without asking.",
          icon: "ShieldOff",
          colorTier: "dangerous",
        },
        nativeMode: "default",
        default: true,
      },
    },
    transformers: [antigravity],
  });
  return {
    ...provider,
    docsUrl: "https://paseo.sh/docs/supported-providers/antigravity#troubleshooting",
    // agy documents no update command and no release source, so there is nothing to check or run.
    installation: {
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      async inspect({ launch, signal }) {
        if (!launch?.resolved) return { status: "not_installed" };
        const version = await readAgyVersion(launch, signal);
        return version ? { status: "installed", version } : { status: "installed" };
      },
    },
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic: `Install Antigravity ${MIN_AGY_VERSION_LABEL} or later.`,
        };
      }
      // A sign-in problem can stop ACP from starting, so the report says which sign-in either way.
      const signIn = describeSignIn(launch.env);
      let version: string | undefined;
      try {
        version = await readAgyVersion(launch);
      } catch {
        return {
          available: false,
          diagnostic: `Antigravity CLI did not report its version. Install Antigravity ${MIN_AGY_VERSION_LABEL} or later.\n${signIn}`,
        };
      }
      if (!version) {
        return {
          available: false,
          diagnostic: `Antigravity CLI did not report its version. Install Antigravity ${MIN_AGY_VERSION_LABEL} or later.\n${signIn}`,
        };
      }
      const parsed = parseSemverTriplet(version);
      if (parsed && !isVersionAtLeast(parsed, MIN_AGY_VERSION)) {
        return {
          available: false,
          diagnostic: `Antigravity CLI ${version} is older than ${MIN_AGY_VERSION_LABEL}. Update Antigravity CLI to ${MIN_AGY_VERSION_LABEL} or later (earlier versions restrict model access for ACP clients).\n${signIn}`,
        };
      }
      return { available: true, diagnostic: signIn };
    },
  };
}
