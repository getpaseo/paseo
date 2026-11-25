import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execCommand } from "@getpaseo/plugin/server";
import { runAcpProvider, type AcpTransformer } from "@getpaseo/plugin/server/acp";
import {
  PROVIDER_PROTOCOL_VERSION,
  type ProviderInstallationLaunch,
  type ProviderRegistration,
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

const PERCENT_ENCODED_BYTE = /%[0-9A-Fa-f]{2}/;
const WINDOWS_LEADING_SLASH_DRIVE = /^\/[A-Za-z]:\//;
const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG", "EINVAL"]);
const INACCESSIBLE_PATH_CODES = new Set(["EACCES", "EPERM"]);

function hasErrnoCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.has(error.code)
  );
}

function decodeListedCwdCandidate(cwd: string): string | null {
  if (cwd.startsWith("file://")) {
    try {
      return fileURLToPath(cwd);
    } catch (error) {
      if (error instanceof TypeError || error instanceof URIError) return null;
      throw error;
    }
  }
  const hasEncodedByte = PERCENT_ENCODED_BYTE.test(cwd);
  const hasLeadingSlashDrive =
    process.platform === "win32" && WINDOWS_LEADING_SLASH_DRIVE.test(cwd);
  if (!hasEncodedByte && !hasLeadingSlashDrive) return null;
  let decoded = cwd;
  if (hasEncodedByte) {
    try {
      decoded = decodeURIComponent(cwd);
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
  }
  if (process.platform === "win32") {
    const withoutLeadingSlash = WINDOWS_LEADING_SLASH_DRIVE.test(decoded)
      ? decoded.slice(1)
      : decoded;
    return path.normalize(withoutLeadingSlash);
  }
  return decoded;
}

// COMPAT(antigravityEncodedSessionCwd): added in v0.18.0, remove once Antigravity CLI decodes
// file:// URIs in session/list. agy 1.5.17 stores workspace paths as percent-encoded file:// URIs
// and strips only the scheme, leaving non-ASCII characters and spaces encoded.
async function normalizeListedCwd(cwd: string): Promise<string> {
  const candidate = decodeListedCwdCandidate(cwd);
  if (candidate === null || candidate === cwd) return cwd;
  try {
    await stat(cwd);
    return cwd;
  } catch (error) {
    if (hasErrnoCode(error, INACCESSIBLE_PATH_CODES)) return cwd;
    if (!hasErrnoCode(error, MISSING_PATH_CODES)) throw error;
  }
  try {
    return (await stat(candidate)).isDirectory() ? candidate : cwd;
  } catch (error) {
    if (hasErrnoCode(error, MISSING_PATH_CODES) || hasErrnoCode(error, INACCESSIBLE_PATH_CODES)) {
      return cwd;
    }
    throw error;
  }
}

const antigravity: AcpTransformer = {
  command(command) {
    return { ...command, kind: builtInCommands.has(command.name) ? "command" : "skill" };
  },
  async sessionSummary(summary) {
    const cwd = await normalizeListedCwd(summary.cwd);
    return cwd === summary.cwd ? summary : { ...summary, cwd };
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

/** The release `agy --version` reports, or its first line when it names no release. */
async function readAgyVersion(
  launch: ProviderInstallationLaunch,
  signal: AbortSignal,
): Promise<string | undefined> {
  // The launch ends with the `acp` subcommand and its flags; the version comes from the CLI itself.
  const acp = launch.args.indexOf("acp");
  const prefix = acp === -1 ? launch.args : launch.args.slice(0, acp);
  const { stdout } = await execCommand(launch.command, [...prefix, "--version"], {
    env: launch.env,
    timeout: 5000,
    maxBuffer: 8192,
    signal,
  });
  const firstLine = stdout.trim().split("\n")[0]?.trim();
  return /\b\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? (firstLine || undefined);
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
    command: ["agy", "acp", "--disable-telemetry"],
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
      if (!launch) return { available: false, diagnostic: "Install Antigravity 1.5.0 or later." };
      // A sign-in problem can stop ACP from starting, so the report says which sign-in either way.
      const signIn = describeSignIn(launch.env);
      try {
        const connection = await provider.connect({
          launch,
          versions: [PROVIDER_PROTOCOL_VERSION],
          capabilities: [],
        });
        await connection.close();
        return { available: true, diagnostic: signIn };
      } catch {
        return {
          available: false,
          diagnostic: `Antigravity ACP did not start. Install Antigravity 1.5.0 or later. If you override the command, include the acp subcommand.\n${signIn}`,
        };
      }
    },
  };
}
