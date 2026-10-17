import path from "node:path";
import { getCommandOptionsWithValues } from "@getpaseo/protocol/terminal-profiles";
import type {
  PersistedTerminal,
  PersistedTerminalAgentSession,
} from "./persisted-terminal-store.js";

export type TerminalRelaunchPlan =
  // Spawn `command` directly; `undefined` spawns the default shell.
  | { kind: "command"; command?: string; args?: string[] }
  // Spawn the default shell and type `input` into it, so quitting the agent
  // leaves the user in the shell they originally started it from.
  | { kind: "shell-input"; input: string };

interface ResumeProvider {
  binary: string;
  // Flags that consume the next token, shared with prompt adoption in the
  // protocol package.
  valueFlags: ReadonlySet<string>;
  // Flags known to take no value. A flag in neither set is kept only when no
  // bare token follows it; otherwise that token may be its value or the
  // original prompt, so both are dropped.
  booleanFlags: ReadonlySet<string>;
  // Flags that pick or fork a session; resume replaces them.
  sessionFlags: ReadonlySet<string>;
  // Leading positionals that select a non-interactive subcommand; such a
  // terminal is not resumable.
  nonInteractiveSubcommands: ReadonlySet<string>;
  resumeArgs(input: { flags: string[]; sessionId: string }): string[];
}

const RESUME_PROVIDERS: Record<PersistedTerminalAgentSession["provider"], ResumeProvider> = {
  claude: {
    binary: "claude",
    valueFlags: getCommandOptionsWithValues("claude"),
    booleanFlags: new Set([
      "--allow-dangerously-skip-permissions",
      "--ax-screen-reader",
      "--bare",
      "--brief",
      "--chrome",
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
      "--exclude-dynamic-system-prompt-sections",
      "--ide",
      "--no-chrome",
      "--no-session-persistence",
      "--restricted",
      "--safe-mode",
      "--strict-mcp-config",
      "--verbose",
    ]),
    sessionFlags: new Set([
      "--resume",
      "-r",
      "--continue",
      "-c",
      "--session-id",
      "--fork-session",
      "--print",
      "-p",
      "--output-format",
      "--input-format",
    ]),
    nonInteractiveSubcommands: new Set(),
    resumeArgs: ({ flags, sessionId }) => [...flags, "--resume", sessionId],
  },
  codex: {
    binary: "codex",
    valueFlags: getCommandOptionsWithValues("codex"),
    booleanFlags: new Set([
      "--approve-for-me",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "--full-auto",
      "--no-alt-screen",
      "--no-daemon",
      "--oss",
      "--search",
      "--strict-config",
      "--worktree",
      "--yolo",
    ]),
    sessionFlags: new Set(["--last", "--all"]),
    nonInteractiveSubcommands: new Set([
      "exec",
      "e",
      "review",
      "apply",
      "a",
      "login",
      "logout",
      "mcp",
      "mcp-server",
      "app-server",
      "completion",
      "sandbox",
      "debug",
      "cloud",
      "features",
    ]),
    // Codex merges root-level TUI flags into the `resume` subcommand.
    resumeArgs: ({ flags, sessionId }) => [...flags, "resume", sessionId],
  },
};

// Session ids are UUIDs or provider-generated slugs. Anything else is refused
// rather than quoted, because it is typed into a shell on restore.
export const SAFE_AGENT_SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/;

const PLAIN_SHELL: TerminalRelaunchPlan = { kind: "command" };

// Stored argv is never replayed without a resumable session: it holds the
// original prompt (`claude <prompt>`, `opencode --prompt=<prompt>`) or a
// one-shot command the user did not ask to rerun. Those terminals come back
// as a plain shell in their cwd.
export function planTerminalRelaunch(record: PersistedTerminal): TerminalRelaunchPlan {
  const session = record.agentSession;
  if (!session || !SAFE_AGENT_SESSION_ID.test(session.sessionId)) {
    return PLAIN_SHELL;
  }
  const provider = RESUME_PROVIDERS[session.provider];

  if (!record.command) {
    const args = provider.resumeArgs({ flags: [], sessionId: session.sessionId });
    return { kind: "shell-input", input: `${[provider.binary, ...args].join(" ")}\r` };
  }

  if (commandName(record.command) !== provider.binary) {
    return PLAIN_SHELL;
  }
  const parsed = parseArgs(record.args ?? [], provider);
  if (parsed.nonInteractive) {
    return PLAIN_SHELL;
  }
  return {
    kind: "command",
    command: record.command,
    args: provider.resumeArgs({ flags: parsed.flags, sessionId: session.sessionId }),
  };
}

function commandName(command: string): string {
  const base = path.basename(command.replaceAll("\\", "/"));
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

// Positional arguments are prompts or subcommands. Replaying them into a
// resumed session would re-send the original prompt, so only flags survive,
// and a flag never survives without the value it was given. Everything after
// `--` is positional.
function parseArgs(
  args: string[],
  provider: ResumeProvider,
): { flags: string[]; nonInteractive: boolean } {
  const flags: string[] = [];
  let sawPositional = false;
  const isBare = (arg: string) => !arg.startsWith("-") || arg === "-";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (isBare(arg)) {
      if (!sawPositional && provider.nonInteractiveSubcommands.has(arg)) {
        return { flags: [], nonInteractive: true };
      }
      sawPositional = true;
      continue;
    }
    const [flag] = arg.split("=", 1);
    let value: string[] = [];
    if (!arg.includes("=") && !provider.booleanFlags.has(flag)) {
      const next = args[index + 1];
      if (provider.valueFlags.has(flag)) {
        value = next === undefined ? [] : [next];
      } else if (next !== undefined && isBare(next)) {
        // Unknown flag: the bare token is its value or the prompt. Drop both,
        // and stay conservative about a subcommand hiding behind it.
        if (!sawPositional && provider.nonInteractiveSubcommands.has(next)) {
          return { flags: [], nonInteractive: true };
        }
        index += 1;
        continue;
      }
    }
    index += value.length;
    if (!provider.sessionFlags.has(flag)) {
      flags.push(arg, ...value);
    }
  }
  return { flags, nonInteractive: false };
}
