import type { Sandbox } from "@vercel/sandbox";
import type { SessionState } from "./types.js";
import { providerLaunchEnvironment, redactText, validateProviderSelection } from "./providers.js";

export interface PairingResult {
  url: string;
  serverId: string;
  daemonPublicKeyB64: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function parsePairingOffer(url: string, label = "pairing offer"): PairingResult {
  try {
    if (!url) throw new Error("missing url");
    const fragment = new URL(url).hash;
    if (!fragment.startsWith("#offer=")) throw new Error("missing offer fragment");
    const offerJson = Buffer.from(fragment.slice("#offer=".length), "base64url").toString("utf8");
    const offer = JSON.parse(offerJson) as {
      v?: unknown;
      serverId?: unknown;
      daemonPublicKeyB64?: unknown;
      relay?: { endpoint?: unknown; useTls?: unknown };
    };
    if (offer.v !== 2) throw new Error("unsupported version");
    if (typeof offer.serverId !== "string" || offer.serverId.length === 0)
      throw new Error("missing serverId");
    if (typeof offer.daemonPublicKeyB64 !== "string") throw new Error("missing daemon key");
    if (!/^[A-Za-z0-9+/]{43}=$/.test(offer.daemonPublicKeyB64))
      throw new Error("invalid daemon key encoding");
    const key = Buffer.from(offer.daemonPublicKeyB64, "base64");
    if (key.length !== 32 || key.toString("base64") !== offer.daemonPublicKeyB64) {
      throw new Error("invalid daemon key");
    }
    if (
      !offer.relay ||
      typeof offer.relay.endpoint !== "string" ||
      offer.relay.endpoint.length === 0
    ) {
      throw new Error("missing relay endpoint");
    }
    if (offer.relay.useTls !== undefined && typeof offer.relay.useTls !== "boolean") {
      throw new Error("invalid relay TLS setting");
    }
    return {
      url,
      serverId: offer.serverId,
      daemonPublicKeyB64: offer.daemonPublicKeyB64,
    };
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

export async function startDaemonAndPair(
  sandbox: Sandbox,
  state: SessionState,
): Promise<PairingResult> {
  const home = state.paseoHome;
  const agentKey = process.env.AI_GATEWAY_API_KEY;
  if (!agentKey) throw new Error("AI_GATEWAY_API_KEY is required before starting the daemon");
  validateProviderSelection(state.agentProvider, state.agentModel);
  // The key travels in env, not args: the Sandbox API persists command args.
  const start = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `if [ ! -d ${shellQuote(home)} ]; then echo 'Paseo state directory is missing' >&2; exit 1; fi; ` +
        `if [ ! -f "$HOME/.paseo-sandbox/configure-providers.js" ]; then echo 'provider configuration script is missing; rerun provision' >&2; exit 1; fi; ` +
        `export CLAUDE_CONFIG_DIR="$HOME/.claude"; ` +
        `export XDG_DATA_HOME="$HOME/.local/share"; ` +
        `export OPENCODE_CONFIG_DIR="$HOME/.config/opencode"; ` +
        `export PI_CODING_AGENT_DIR="$HOME/.pi/agent"; ` +
        `export OPENCODE_AUTH_CONTENT=; ` +
        `if ! node "$HOME/.paseo-sandbox/configure-providers.js"; then echo 'provider configuration refresh failed; refusing to start daemon' >&2; exit 1; fi; ` +
        `export PASEO_HOME=${shellQuote(home)}; ` +
        `export PATH="$HOME/.npm-global/bin:$PATH"; ` +
        `nohup paseo daemon start --foreground --home ${shellQuote(home)} --listen 127.0.0.1:6767 --relay > ${shellQuote(home + "/daemon.log")} 2>&1 & ` +
        `for i in $(seq 1 150); do ` +
        `  out=$(paseo daemon status --home ${shellQuote(home)} --json 2>/dev/null) && ` +
        `  echo "$out" | grep -q '"localDaemon": *"running"' && break; ` +
        `  sleep 1; ` +
        `done; ` +
        `paseo daemon status --home ${shellQuote(home)} --json; ` +
        `tail -20 ${shellQuote(home + "/daemon.log")} >&2 2>/dev/null || true`,
    ],
    env: providerLaunchEnvironment(agentKey, state.agentModel),
    timeoutMs: 240_000,
  });
  const startOut = await start.stdout();
  const startErr = await start.stderr();
  // paseo daemon status exits 0 even for a stopped daemon, so the exit code
  // alone cannot prove startup. Require localDaemon running in the JSON.
  const looksAlive = /"localDaemon"\s*:\s*"running"/.test(startOut);
  if (start.exitCode !== 0 || !looksAlive) {
    throw new Error(
      redactText(
        `daemon failed to start: exit ${start.exitCode}\n${startOut}\n${startErr}`,
        agentKey,
      ),
    );
  }

  const pair = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `export PASEO_HOME=${shellQuote(home)}; ` +
        `export PATH="$HOME/.npm-global/bin:$PATH"; ` +
        `paseo daemon pair --relay --json --home ${shellQuote(home)}`,
    ],
    timeoutMs: 30_000,
  });
  const pairOut = await pair.stdout();
  if (pair.exitCode !== 0) throw new Error(`pairing failed: exit ${pair.exitCode}`);
  let parsed: { url?: string };
  try {
    parsed = JSON.parse(pairOut.trim());
  } catch {
    throw new Error("pairing returned invalid JSON");
  }
  if (!parsed.url) throw new Error("pairing did not return a url");
  return parsePairingOffer(parsed.url);
}
