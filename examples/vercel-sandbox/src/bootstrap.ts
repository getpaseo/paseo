import type { Sandbox } from "@vercel/sandbox";
import type { SessionState } from "./types.js";
import { PROVIDERS, providerConfigScript, redactText, resolveProvider } from "./providers.js";

export const PASEO_CLI_VERSION = "0.8.0";
export const DEFAULT_PASEO_HOME = "/vercel/paseo-home";
export const DEFAULT_WORKSPACE = "/vercel/workspace";
export const DEFAULT_REPO_PATH = "/vercel/workspace/repo";

export const AGENT_CLI_PINS = Object.values(PROVIDERS).map((provider) =>
  Object.assign({}, provider, {
    spec: `${provider.package}@${provider.version}`,
  }),
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function bootstrapScript(state: SessionState): string {
  resolveProvider(state.agentProvider);

  return `#!/bin/bash
set -euo pipefail

PASEO_HOME=${shellQuote(state.paseoHome)}
export PASEO_HOME
WORKSPACE_PATH=${shellQuote(state.workspacePath)}
REPO_PATH=${shellQuote(state.repoPath)}
${state.repoUrl === undefined ? "" : `REPO_URL=${shellQuote(state.repoUrl)}\n`}
export PATH="$HOME/.npm-global/bin:$PATH"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"

printf '== bootstrap paseo-sandbox %s ==\\n' ${shellQuote(state.name)}

node --version
npm --version

mkdir -p -- "$PASEO_HOME" "$WORKSPACE_PATH" "$REPO_PATH"

${
  state.repoUrl === undefined
    ? ""
    : `if [ -d "$REPO_PATH" ]; then
  if ! destination_entries="$(find "$REPO_PATH" -mindepth 1 -print -quit)"; then
    printf 'bootstrap repository failure: unable to inspect destination\\n' >&2
    exit 1
  fi

  if [ -n "$destination_entries" ]; then
    if [ ! -e "$REPO_PATH/.git" ] || ! git -C "$REPO_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      printf 'bootstrap repository failure: destination has unrelated contents\\n' >&2
      exit 1
    fi

    if ! existing_origin="$(git -C "$REPO_PATH" remote get-url origin)"; then
      printf 'bootstrap repository failure: existing checkout has no origin\\n' >&2
      exit 1
    fi

    if [ "$existing_origin" != "$REPO_URL" ]; then
      printf 'bootstrap repository failure: existing checkout origin does not match repoUrl\\n' >&2
      exit 1
    fi
  else
    if ! git clone -- "$REPO_URL" "$REPO_PATH"; then
      printf 'bootstrap repository failure: git clone failed\\n' >&2
      exit 1
    fi
  fi
else
  if ! git clone -- "$REPO_URL" "$REPO_PATH"; then
    printf 'bootstrap repository failure: git clone failed\\n' >&2
    exit 1
  fi
fi
`
}

check_cli() {
  local command_name="$1" package_spec="$2"
  local package_name="\${package_spec%@*}"
  local package_version="\${package_spec##*@}"
  local package_dir="$HOME/.npm-global/lib/node_modules/$package_name"
  if [ ! -d "$package_dir" ]; then
    npm install -g "$package_name@$package_version"
  fi
  if [ -f "$package_dir/package.json" ] && ! node -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (pkg.version !== process.argv[2]) process.exit(1);
  ' "$package_dir/package.json" "$package_version"; then
    printf 'bootstrap failure: installed %s does not match pinned version %s\\n' "$package_name" "$package_version" >&2
    exit 1
  fi
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'bootstrap failure: %s CLI is not executable on PATH\\n' "$command_name" >&2
    exit 1
  }
}

check_cli paseo @getpaseo/cli@${PASEO_CLI_VERSION}
${AGENT_CLI_PINS.map((pin) => `check_cli ${pin.binary} ${shellQuote(`${pin.package}@${pin.version}`)}`).join("\n")}

paseo --version
${AGENT_CLI_PINS.map((pin) => `${pin.binary} --version`).join("\n")}

PROVIDER_CONFIG_SCRIPT="$HOME/.paseo-sandbox/configure-providers.js"
mkdir -p -- "$HOME/.paseo-sandbox"
cat > "$PROVIDER_CONFIG_SCRIPT" <<'PASEO_PROVIDER_CONFIG_EOF'
${providerConfigScript(state)}
PASEO_PROVIDER_CONFIG_EOF
chmod 700 "$PROVIDER_CONFIG_SCRIPT"
export CLAUDE_CONFIG_DIR="$HOME/.claude"
export XDG_DATA_HOME="$HOME/.local/share"
export OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
export OPENCODE_AUTH_CONTENT=
node "$PROVIDER_CONFIG_SCRIPT"

echo "bootstrap complete"
`;
}

export async function writeBootstrapToSandbox(
  sandbox: Sandbox,
  state: SessionState,
): Promise<void> {
  const content = Buffer.from(bootstrapScript(state), "utf8");
  await sandbox.writeFiles([{ path: "/vercel/bootstrap.sh", content, mode: 0o755 }]);
}

export async function runBootstrap(sandbox: Sandbox, _state: SessionState): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: "/bin/bash",
    args: ["/vercel/bootstrap.sh"],
    env: { AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? "" },
    timeoutMs: 10 * 60 * 1000,
  });
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  if (result.exitCode !== 0) {
    throw new Error(
      redactText(`bootstrap failed (exit ${result.exitCode}):\n${stdout}\n${stderr}`),
    );
  }
}
