import type { SshHostConfig } from "./ssh-host-config.js";

/**
 * Quote a value for safe interpolation into a POSIX shell script. Everything
 * the ensure script embeds — hostnames, paths, version specs — comes from user
 * config, so it must survive quotes, `$`, backticks, and spaces intact.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Expand a leading `~` to `$HOME` for use inside a remote command. The remote
 * shell expands `$HOME` but not a `~` that survives quoting, so remote paths
 * are spelled with `$HOME` and concatenated outside the quotes.
 */
export function remoteExpandHome(p: string): string {
  if (p === "~") return "$HOME";
  if (p.startsWith("~/")) return `$HOME/${p.slice(2)}`;
  return p;
}

/**
 * Render a path as a single shell word. `~`-relative paths become `"$HOME"`
 * followed by a single-quoted remainder, so the tilde expands but nothing in
 * the rest of the path can be reinterpreted by the shell.
 */
export function shellPath(p: string): string {
  if (p === "~") return `"$HOME"`;
  if (p.startsWith("~/")) return `"$HOME"/${shellQuote(p.slice(2))}`;
  return shellQuote(p);
}

/** Remote PASEO_HOME, with `~` expanded to `$HOME`. */
export function remoteHomePath(config: SshHostConfig): string {
  return remoteExpandHome(config.remoteHome);
}

/** Remote Paseo install directory, with `~` expanded to `$HOME`. */
export function remoteInstallPath(config: SshHostConfig): string {
  return remoteExpandHome(config.installDir);
}

/**
 * Exit codes the ensure script reports back through SSH. They are the contract
 * between {@link buildEnsureScript} and {@link describeEnsureFailure}.
 */
export const ENSURE_EXIT = {
  ready: 0,
  nodeMissing: 10,
  installFailed: 11,
  notReady: 12,
  npmMissing: 13,
} as const;

/**
 * Structured markers the ensure script writes to stderr. `PROGRESS:` lines are
 * human-facing status text and may be reworded freely; `READY:` is the machine
 * contract that tells the tunnel the daemon is accepting connections. Keeping
 * the two separate means rewording user-facing status cannot silently break
 * readiness detection.
 */
export const PROGRESS_MARKER = "PROGRESS:";
export const READY_MARKER = "READY:";

/**
 * Emitted by the askpass program when the user dismisses the prompt.
 *
 * SSH gives askpass no way to report a cancellation — it ignores the program's
 * exit status and simply retries up to `NumberOfPasswordPrompts`, so a
 * dismissed prompt is indistinguishable from a wrong password and reappears.
 * But askpass is *our* program and it does know the difference, and its stderr
 * is inherited by ssh (only stdout is redirected to the password pipe), so it
 * can say so on the same stream the tunnel already parses.
 *
 * Used by the CLI's terminal prompt. The desktop app answers prompts over
 * {@link ../askpass-channel.js} instead and signals cancellation directly.
 */
export const ASKPASS_CANCELLED_MARKER = "PASEO_ASKPASS:cancelled";

/**
 * The command `ssh` runs on the remote host.
 *
 * sshd executes a remote command as `<user's shell> -c "<command>"`, using the
 * shell from the password database. That is not a login shell, but it *is* the
 * user's shell binary — so a host where someone has `chsh`'d to fish or tcsh
 * would try to parse our POSIX script with fish or tcsh and fail outright.
 *
 * Wrapping the script as `/bin/sh -c '<script>'` does not help: the outer
 * string still goes through that shell, and neither fish nor csh can carry the
 * quotes and newlines the script contains. So the command is reduced to three
 * words with no metacharacters at all — every shell agrees on what that
 * means — and the script itself is piped in over stdin.
 *
 * Two things fall out of this for free: nothing needs shell-escaping on the way
 * in, and the script no longer shows up in the remote host's process list,
 * where any other user could read it.
 */
export const REMOTE_SHELL_COMMAND = "exec /bin/sh";

/** How long the remote script waits for the daemon to start listening. */
export const REMOTE_READY_TIMEOUT_MS = 30_000;
// Whole seconds: POSIX `sleep` only guarantees integer arguments, and BusyBox
// builds without FANCY_SLEEP reject "0.5".
const REMOTE_POLL_INTERVAL_MS = 1_000;

/**
 * Build a single self-contained shell script that ensures a Paseo daemon is
 * running on the remote host. The script:
 *
 * 1. Returns immediately if the daemon port is already listening
 * 2. Prefers a `paseo` already on `PATH` (global npm, system package manager)
 * 3. Otherwise installs — or upgrades — a Paseo-managed copy under `installDir`
 * 4. Launches the daemon detached
 * 5. Waits for the port to accept connections
 *
 * Preferring a `PATH` install matters for correctness, not just disk: if we
 * installed a second copy, a user on the remote host could start *their*
 * daemon from the system binary while we run a different build against the
 * same `PASEO_HOME`, and the two would fight over the port and the agent
 * state. Paseo only ever installs or upgrades inside `installDir` — never a
 * binary it did not put there.
 *
 * The script is piped to a remote `/bin/sh` over the SSH connection's stdin
 * rather than passed as the remote command, so the user's own shell never has
 * to parse it. See {@link REMOTE_SHELL_COMMAND}.
 *
 * On success it deliberately falls off the end without exiting: `sh` reading a
 * script from a pipe blocks for more input, which is what holds the port
 * forward open. Closing stdin is the teardown signal. On failure it exits with
 * a code from {@link ENSURE_EXIT}, which `ssh` reports as its own exit code.
 *
 * The script runs in a single SSH call — one auth, one connection, no
 * multiplexing.
 */
export function buildEnsureScript(config: SshHostConfig, version: string): string {
  const home = shellPath(config.remoteHome);
  const installDir = shellPath(config.installDir);
  const host = config.host;
  const wanted = version.trim() || "latest";
  const maxPolls = Math.floor(REMOTE_READY_TIMEOUT_MS / REMOTE_POLL_INTERVAL_MS);

  // Exits 0 if the port accepts a connection, 1 otherwise. Node is the only
  // runtime we can rely on (Paseo itself needs it), so the check uses it
  // rather than nc or bash-isms that vary across remote hosts.
  const portCheck = `node -e 'const n=require("net");const s=n.connect({port:${config.remotePort},host:"127.0.0.1"});s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>{s.destroy();process.exit(1)},3000)'`;

  return [
    // Wrapped in a function so `return` unwinds to the caller instead of
    // killing the shell — the tunnel needs this shell to stay alive.
    `ensure_daemon() {`,
    `  paseo_home=${home}`,
    `  paseo_dir=${installDir}`,
    `  paseo_want=${shellQuote(wanted)}`,
    ``,
    `  if ! command -v node >/dev/null 2>&1; then`,
    `    echo "${PROGRESS_MARKER}Node.js is required on ${host} to run the Paseo daemon." >&2`,
    `    return ${ENSURE_EXIT.nodeMissing}`,
    `  fi`,
    ``,
    `  # 1. Already running? Whatever owns the port keeps it; never double-start.`,
    `  if ${portCheck}; then`,
    `    echo "${PROGRESS_MARKER}Remote daemon is already running." >&2`,
    `    echo "${READY_MARKER}running" >&2`,
    `    return 0`,
    `  fi`,
    ``,
    `  # 2. Prefer a paseo the host already provides (global npm, system package`,
    `  #    manager, nix, ...) so we never run a second, conflicting daemon.`,
    `  paseo_bin=$(command -v paseo 2>/dev/null || true)`,
    `  if [ -n "$paseo_bin" ]; then`,
    `    echo "${PROGRESS_MARKER}Using the Paseo already installed on ${host} ($paseo_bin)." >&2`,
    `  else`,
    `    paseo_bin="$paseo_dir/node_modules/.bin/paseo"`,
    `    # 3. Install or upgrade the copy Paseo manages under its own directory.`,
    `    paseo_have=""`,
    `    if [ -x "$paseo_bin" ]; then`,
    `      paseo_have=$(cd "$paseo_dir" && node -p "require('./node_modules/@getpaseo/cli/package.json').version" 2>/dev/null || true)`,
    `    fi`,
    `    if [ "$paseo_have" = "$paseo_want" ]; then`,
    `      echo "${PROGRESS_MARKER}Paseo $paseo_want is already installed on ${host}." >&2`,
    `    else`,
    `      if ! command -v npm >/dev/null 2>&1; then`,
    `        echo "${PROGRESS_MARKER}npm is required on ${host} to install Paseo." >&2`,
    `        return ${ENSURE_EXIT.npmMissing}`,
    `      fi`,
    `      if [ -n "$paseo_have" ]; then`,
    `        echo "${PROGRESS_MARKER}Updating Paseo on ${host} from $paseo_have to $paseo_want…" >&2`,
    `      else`,
    `        echo "${PROGRESS_MARKER}Installing Paseo $paseo_want on ${host}…" >&2`,
    `      fi`,
    `      mkdir -p "$paseo_dir"`,
    `      if ! npm install --prefix "$paseo_dir" "@getpaseo/cli@$paseo_want" </dev/null >&2; then`,
    // A source checkout or an unpublished beta has no registry entry. Falling
    // back keeps "connect from a dev build" working instead of hard-failing.
    `        if [ "$paseo_want" = latest ]; then`,
    `          echo "${PROGRESS_MARKER}Failed to install Paseo on ${host}." >&2`,
    `          return ${ENSURE_EXIT.installFailed}`,
    `        fi`,
    `        echo "${PROGRESS_MARKER}Paseo $paseo_want is not published; installing the latest release instead…" >&2`,
    `        if ! npm install --prefix "$paseo_dir" "@getpaseo/cli@latest" </dev/null >&2; then`,
    `          echo "${PROGRESS_MARKER}Failed to install Paseo on ${host}." >&2`,
    `          return ${ENSURE_EXIT.installFailed}`,
    `        fi`,
    `      fi`,
    `      echo "${PROGRESS_MARKER}Paseo installed on ${host}." >&2`,
    `    fi`,
    `  fi`,
    ``,
    `  # 4. Launch the daemon. Output goes to stderr so it lands in the`,
    `  #    diagnostics we surface on failure; stdin is closed because this`,
    `  #    script is itself arriving on stdin and a child that reads it would`,
    `  #    swallow the rest of the script.`,
    `  echo "${PROGRESS_MARKER}Launching the Paseo daemon on ${host}…" >&2`,
    `  mkdir -p "$paseo_home"`,
    `  "$paseo_bin" daemon start --home "$paseo_home" --port ${config.remotePort} --no-relay --no-mcp </dev/null >&2`,
    ``,
    `  # 5. Wait for the port to accept connections.`,
    `  echo "${PROGRESS_MARKER}Waiting for the remote daemon to become ready…" >&2`,
    `  paseo_i=0`,
    `  while [ $paseo_i -lt ${maxPolls} ]; do`,
    `    if ${portCheck}; then`,
    `      echo "${PROGRESS_MARKER}Remote daemon is ready." >&2`,
    `      echo "${READY_MARKER}launched" >&2`,
    `      return 0`,
    `    fi`,
    `    sleep ${REMOTE_POLL_INTERVAL_MS / 1000}`,
    `    paseo_i=$((paseo_i + 1))`,
    `  done`,
    `  echo "${PROGRESS_MARKER}The daemon was launched on ${host} but never started listening." >&2`,
    `  return ${ENSURE_EXIT.notReady}`,
    `}`,
    // Preserve the exit code: `ensure_daemon && ...` would collapse every
    // failure to 1 and lose the reason.
    //
    // On success there is deliberately no `exit` and no keepalive command. This
    // script arrives on `sh`'s stdin, so falling off the end leaves `sh`
    // blocked reading the next line — that block *is* the keepalive, and it
    // needs no `cat` or `sleep infinity` (which BusyBox and older BSD sleep
    // reject anyway). The tunnel closes stdin to tear it down.
    `ensure_daemon; paseo_rc=$?; [ $paseo_rc -eq 0 ] || exit $paseo_rc`,
  ].join("\n");
}

/**
 * Describe a failure that came from `ssh` itself rather than the ensure
 * script. SSH exits 255 for auth, connection, host-key, and DNS failures; its
 * stderr is the only useful diagnostic, so it is surfaced verbatim.
 */
export function describeSshFailure(host: string, exitCode: number | null, stderr: string): string {
  const detail = stderr.trim();
  if (exitCode === 255) {
    return `SSH connection to ${host} failed.${detail ? `\n${detail}` : ""}`;
  }
  if (detail) {
    return `Failed to start the Paseo daemon on ${host}.\n${detail}`;
  }
  return `Failed to start the Paseo daemon on ${host} (exit code ${exitCode ?? "unknown"}).`;
}

/**
 * Turn an ensure-script exit code into an actionable message. The tunnel runs
 * the script inline over the same SSH connection, so this is the only place
 * that knows what a non-zero exit meant.
 */
export function describeEnsureFailure(input: {
  config: SshHostConfig;
  exitCode: number | null;
  stderr: string;
}): string {
  const { config } = input;
  const stderr = input.stderr.trim();
  switch (input.exitCode) {
    case ENSURE_EXIT.nodeMissing:
      return (
        `Node.js is required on ${config.host} to run the Paseo daemon. ` +
        `Install Node.js (https://nodejs.org) on the remote host and retry.`
      );
    case ENSURE_EXIT.npmMissing:
      return (
        `npm is required on ${config.host} to install Paseo. ` +
        `Install npm there, or install Paseo on the remote host yourself and retry.`
      );
    case ENSURE_EXIT.installFailed:
      return `Failed to install Paseo on ${config.host}.${stderr ? `\n${stderr}` : ""}`;
    case ENSURE_EXIT.notReady:
      return (
        `The Paseo daemon was launched on ${config.host} but did not start listening on port ` +
        `${config.remotePort} within ${REMOTE_READY_TIMEOUT_MS / 1000}s. ` +
        `Check ${config.remoteHome}/daemon.log on the remote host.`
      );
    default:
      return describeSshFailure(config.host, input.exitCode, stderr);
  }
}
