import type { Sandbox } from "@vercel/sandbox";
import type { SessionState } from "./types.js";
import {
  providerLaunchEnvironment,
  redactDiagnostic,
  redactText,
  resolveProvider,
} from "./providers.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface ProviderDiagnosticResult {
  provider: string;
  ok: boolean;
  diagnostic: unknown;
}

// oxlint-disable-next-line complexity -- Keep the diagnostic validation and redaction together.
export async function providerDiagnostic(
  sandbox: Sandbox,
  state: SessionState,
): Promise<ProviderDiagnosticResult> {
  const provider = resolveProvider(state.agentProvider);
  const agentKey = process.env.AI_GATEWAY_API_KEY;
  if (!agentKey) {
    return {
      provider: provider.id,
      ok: false,
      diagnostic: {
        error:
          "AI_GATEWAY_API_KEY is required; set it and refresh credentials before diagnosing the provider",
      },
    };
  }
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `export PASEO_HOME=${shellQuote(state.paseoHome)}; ` +
        `export PATH="$HOME/.npm-global/bin:$PATH"; ` +
        `export CLAUDE_CONFIG_DIR="$HOME/.claude"; ` +
        `export XDG_DATA_HOME="$HOME/.local/share"; ` +
        `export OPENCODE_CONFIG_DIR="$HOME/.config/opencode"; ` +
        `export PI_CODING_AGENT_DIR="$HOME/.pi/agent"; ` +
        `export OPENCODE_AUTH_CONTENT=; ` +
        `paseo provider diagnostic ${provider.id} --json`,
    ],
    env: providerLaunchEnvironment(agentKey, state.agentModel),
    timeoutMs: 180_000,
  });
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  let payload: unknown;
  let diagnosticText: string | undefined;
  let parseError: string | undefined;
  try {
    payload = JSON.parse(stdout.trim() || "null");
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as { provider?: unknown; diagnostic?: unknown };
      if (record.provider !== provider.id)
        parseError = "provider diagnostic returned a different provider";
      if (typeof record.diagnostic === "string") diagnosticText = record.diagnostic;
      else parseError = "provider diagnostic returned no diagnostic text";
    } else {
      parseError = "provider diagnostic returned invalid JSON";
    }
  } catch {
    parseError = `provider diagnostic returned invalid JSON (exit ${result.exitCode})`;
  }
  const status = diagnosticText?.match(/Status:\s*([^\n]+)/i)?.[1]?.trim();
  const modelCount = diagnosticText?.match(/Models:\s*(\d+|—)/i)?.[1];
  const ready = status?.toLowerCase() === "ready";
  const hasModels = Boolean(modelCount && modelCount !== "—" && Number(modelCount) > 0);
  const errors = [
    result.exitCode !== 0 ? `provider diagnostic exited with ${result.exitCode}` : undefined,
    parseError,
    diagnosticText && !ready ? `provider status is not Ready: ${status ?? "unknown"}` : undefined,
    ready && !hasModels
      ? "provider catalog is ready but empty; verify CLI compatibility and provider discovery"
      : undefined,
  ].filter(Boolean);
  return {
    provider: provider.id,
    ok: errors.length === 0,
    diagnostic: redactDiagnostic(
      {
        diagnostic: diagnosticText ?? payload,
        errors,
        stderr,
      },
      agentKey,
    ),
  };
}

export async function runFixtureTask(
  sandbox: Sandbox,
  state: SessionState,
  prompt: string,
): Promise<string> {
  const provider = resolveProvider(state.agentProvider).id;
  let modelPrefix = "";
  if (provider === "opencode") modelPrefix = "vercel/";
  if (provider === "pi") modelPrefix = "vercel-ai-gateway/";
  const model = `${modelPrefix}${state.agentModel}`;
  const mode = {
    codex: "full-access",
    claude: "bypassPermissions",
    opencode: "full-access",
    pi: null,
    copilot: "allow-all",
  }[provider];
  const cmd =
    `export PASEO_HOME=${shellQuote(state.paseoHome)}; ` +
    `export PATH="$HOME/.npm-global/bin:$PATH"; ` +
    `cd ${shellQuote(state.repoPath)} && ` +
    `paseo run --provider ${shellQuote(provider)} --model ${shellQuote(model)} ` +
    `${mode ? `--mode ${mode} ` : ""}${shellQuote(prompt)}`;
  const result = await sandbox.runCommand("bash", ["-lc", cmd]);
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  if (result.exitCode !== 0) {
    throw new Error(
      redactText(`fixture task failed: exit ${result.exitCode}\n${stdout}\n${stderr}`),
    );
  }
  return stdout;
}

export async function gitDiff(sandbox: Sandbox, state: SessionState): Promise<string> {
  // Stage everything so new and already-staged files are visible, then report
  // both the path list and the staged patch. Fixture workspace only.
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `cd ${shellQuote(state.repoPath)} && git add -A && echo "== STATUS ==" && git status --porcelain && echo "== DIFF ==" && git diff --cached`,
    ],
  });
  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    throw new Error(`git diff failed: exit ${result.exitCode}\n${stderr}`);
  }
  return result.stdout();
}
