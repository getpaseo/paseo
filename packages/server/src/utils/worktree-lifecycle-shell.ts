import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorktreeSetupCommandProgressEvent, WorktreeSetupCommandResult } from "./worktree.js";

export type WorktreeLifecycleShellDialect = "bash" | "zsh" | "fish";

export interface WorktreeLifecycleShellChoice {
  shell: string;
  dialect: WorktreeLifecycleShellDialect;
}

const SUPPORTED_LIFECYCLE_SHELL_DIALECTS = new Set<WorktreeLifecycleShellDialect>([
  "bash",
  "zsh",
  "fish",
]);

function isSupportedLifecycleShellDialect(value: string): value is WorktreeLifecycleShellDialect {
  return SUPPORTED_LIFECYCLE_SHELL_DIALECTS.has(value as WorktreeLifecycleShellDialect);
}

/**
 * Only bash/zsh/fish are recognized — `buildWorktreeLifecycleScript` emits a
 * dialect-specific script for each. Any other `$SHELL` falls back to the
 * legacy per-entry loop untouched.
 */
export function resolveWorktreeLifecycleShell(
  env: NodeJS.ProcessEnv,
): WorktreeLifecycleShellChoice | null {
  const shellPath = env.SHELL?.trim();
  if (!shellPath) {
    return null;
  }
  const dialect = basename(shellPath);
  if (!isSupportedLifecycleShellDialect(dialect)) {
    return null;
  }
  return { shell: shellPath, dialect };
}

export interface WorktreeLifecycleShellInvocation {
  shell: string;
  args: string[];
}

export interface BuildWorktreeLifecycleShellInvocationOptions {
  shell: string;
  script: string;
}

export function buildWorktreeLifecycleShellInvocation(
  input: BuildWorktreeLifecycleShellInvocationOptions,
): WorktreeLifecycleShellInvocation {
  // -i sources .bashrc/.zshrc (oh-my-zsh only loads under an interactive
  // shell); -l sources .bash_profile/.zprofile (e.g. Homebrew's shellenv).
  // fish reads config.fish either way, but its own plugins/activation
  // scripts commonly gate themselves on `status is-interactive` or
  // `status is-login`, so both flags matter there too.
  return {
    shell: input.shell,
    args: ["-i", "-l", "-c", input.script],
  };
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// fish single-quoted strings support exactly two escapes (\\ and \'), unlike
// POSIX sh where single quotes admit no escapes at all.
function quoteFishShellArg(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export interface WorktreeLifecycleScript {
  script: string;
  markerToken: string;
}

interface WorktreeLifecycleScriptBodyInput {
  commands: string[];
  originalPath: string | undefined;
  markerToken: string;
}

/**
 * bash/zsh script body: POSIX sh-family syntax (`{ ...; }`, `$?`, `[ ... ]`).
 */
function buildPosixLifecycleScript(input: WorktreeLifecycleScriptBodyInput): string {
  const lines: string[] = [];

  if (input.originalPath) {
    // The login/interactive shell above already sourced the user's profile
    // (and whatever it did to PATH) by the time this line runs. Appending the
    // daemon's own pre-invocation PATH as a fallback means profile-added
    // entries (nvm/mise shims) win, but nothing the daemon needs becomes
    // totally unreachable even if a profile replaces PATH outright.
    lines.push(`export PATH="$PATH":${quotePosixShellArg(input.originalPath)}`);
  }

  input.commands.forEach((command, arrayIndex) => {
    const index = arrayIndex + 1;
    const startMarker = quotePosixShellArg(`${input.markerToken}|START|${index}`);
    const quotedMarkerToken = quotePosixShellArg(input.markerToken);
    lines.push(
      // The leading \n guards against the *previous* command's last write
      // lacking a trailing newline — without it, that leftover text and this
      // marker would land on the same line and fail to parse as a marker.
      `printf '\\n%s\\n' ${startMarker}`,
      `printf '\\n%s\\n' ${startMarker} 1>&2`,
      "{",
      command,
      "}",
      "__paseo_lifecycle_status=$?",
      `printf '\\n%s|END|${index}|%s\\n' ${quotedMarkerToken} "$__paseo_lifecycle_status"`,
      `printf '\\n%s|END|${index}|%s\\n' ${quotedMarkerToken} "$__paseo_lifecycle_status" 1>&2`,
      'if [ "$__paseo_lifecycle_status" -ne 0 ]; then exit "$__paseo_lifecycle_status"; fi',
    );
  });

  return lines.join("\n");
}

/**
 * fish script body: fish isn't POSIX and doesn't share bash/zsh's `{ ...; }`
 * grouping, `$?`, or `[ ... ]` syntax, so it gets its own generator rather
 * than reusing `buildPosixLifecycleScript`. `begin ... end` groups without a
 * subshell (like `{ ...; }`), `$status` replaces `$?`, and PATH is a native
 * list variable rather than a colon-joined string.
 */
function buildFishLifecycleScript(input: WorktreeLifecycleScriptBodyInput): string {
  const lines: string[] = [];

  if (input.originalPath) {
    lines.push(`set -gx PATH $PATH (string split ':' -- ${quoteFishShellArg(input.originalPath)})`);
  }

  input.commands.forEach((command, arrayIndex) => {
    const index = arrayIndex + 1;
    const startMarker = quoteFishShellArg(`${input.markerToken}|START|${index}`);
    const quotedMarkerToken = quoteFishShellArg(input.markerToken);
    lines.push(
      // See buildPosixLifecycleScript for why each marker printf leads with \n.
      `printf '\\n%s\\n' ${startMarker}`,
      `printf '\\n%s\\n' ${startMarker} 1>&2`,
      "begin",
      command,
      "end",
      "set -g __paseo_lifecycle_status $status",
      `printf '\\n%s|END|${index}|%s\\n' ${quotedMarkerToken} "$__paseo_lifecycle_status"`,
      `printf '\\n%s|END|${index}|%s\\n' ${quotedMarkerToken} "$__paseo_lifecycle_status" 1>&2`,
      'if test "$__paseo_lifecycle_status" -ne 0',
      '  exit "$__paseo_lifecycle_status"',
      "end",
    );
  });

  return lines.join("\n");
}

/**
 * Builds one shell script that runs every `commands` entry sequentially in a
 * single shell session (so exported vars, `cd`, and shell functions from one
 * entry are visible to the next), while still reporting each entry's own
 * output/exit code via marker lines an output parser can split back apart.
 *
 * Markers are echoed to both stdout and stderr so each stream can be
 * segmented independently by `createWorktreeLifecycleOutputParser`, and the
 * marker format itself is identical across dialects — only the surrounding
 * control-flow/PATH syntax varies, isolated in the per-dialect builders
 * above.
 */
export interface BuildWorktreeLifecycleScriptOptions {
  commands: string[];
  originalPath: string | undefined;
  dialect: WorktreeLifecycleShellDialect;
}

export function buildWorktreeLifecycleScript(
  input: BuildWorktreeLifecycleScriptOptions,
): WorktreeLifecycleScript {
  const markerToken = `__paseo_lifecycle_${randomUUID().replace(/-/g, "")}__`;
  const bodyInput: WorktreeLifecycleScriptBodyInput = {
    commands: input.commands,
    originalPath: input.originalPath,
    markerToken,
  };
  const script =
    input.dialect === "fish"
      ? buildFishLifecycleScript(bodyInput)
      : buildPosixLifecycleScript(bodyInput);

  return { script, markerToken };
}

type MarkerLine = { kind: "start"; index: number } | { kind: "end"; index: number; status: number };

function matchMarkerLine(line: string, markerToken: string): MarkerLine | null {
  if (!line.startsWith(`${markerToken}|`)) {
    return null;
  }
  const parts = line.split("|");
  if (parts[1] === "START" && parts[2] !== undefined) {
    const index = Number(parts[2]);
    return Number.isInteger(index) ? { kind: "start", index } : null;
  }
  if (parts[1] === "END" && parts[2] !== undefined && parts[3] !== undefined) {
    const index = Number(parts[2]);
    const status = Number(parts[3]);
    return Number.isInteger(index) && Number.isInteger(status)
      ? { kind: "end", index, status }
      : null;
  }
  return null;
}

type LifecycleStream = "stdout" | "stderr";

interface LifecycleSegmentState {
  index: number;
  command: string;
  cwd: string;
  startedAt: number;
  stdoutClosed: boolean;
  stderrClosed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface WorktreeLifecycleOutputParser {
  feed(stream: LifecycleStream, chunk: string): WorktreeSetupCommandProgressEvent[];
  finalize(finalExitCode: number | null): WorktreeSetupCommandResult[];
}

/**
 * Consumes raw stdout/stderr chunks from a single shell process running a
 * `buildWorktreeLifecycleScript` script and reconstructs the same
 * `WorktreeSetupCommandProgressEvent`/`WorktreeSetupCommandResult` shapes the
 * legacy one-process-per-entry loop produced, so callers (live timeline
 * emission, final result arrays) don't need to know execution was merged.
 */
export interface CreateWorktreeLifecycleOutputParserOptions {
  markerToken: string;
  commands: string[];
  cwd: string;
}

export function createWorktreeLifecycleOutputParser(
  input: CreateWorktreeLifecycleOutputParserOptions,
): WorktreeLifecycleOutputParser {
  const total = input.commands.length;
  const segments = new Map<number, LifecycleSegmentState>();
  const order: number[] = [];
  let activeStdoutIndex: number | null = null;
  let activeStderrIndex: number | null = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  // Anything emitted before any marker is ever seen — only surfaced if the
  // shell never reaches command 1 at all (e.g. it fails during its own
  // interactive/login startup), so that failure isn't silently swallowed.
  let preamble = "";
  // Every marker printf is prefixed with a `\n` (see
  // `buildWorktreeLifecycleScript`) so a preceding command's non-newline-
  // terminated last write can't merge onto the same line as the marker text.
  // That guard newline arrives as a blank line right before the closing
  // marker. Hold the most recent blank line back instead of appending it
  // immediately: if a marker follows, it was our own guard artifact and gets
  // dropped; if real content follows instead, it's a genuine blank line and
  // gets flushed first, in order.
  let pendingBlankStdout = false;
  let pendingBlankStderr = false;
  // stdout and stderr are independent pipes with no delivery-order guarantee
  // relative to each other, so stdout can race arbitrarily far ahead of
  // stderr — not just by one command. By the time stderr finally reports
  // command N's END marker, stdout may have already delivered START (and
  // even END) for N+1, N+2, and beyond. Emitting command_started for any of
  // those immediately would show multiple commands "running" at once in the
  // live timeline, so each is held back in this set until its immediate
  // predecessor has fully closed on both streams. A single scalar slot here
  // would let a later deferred index silently overwrite an earlier one.
  let lastCompletedIndex = 0;
  const pendingStartIndices = new Set<number>();

  function getOrCreateSegment(index: number): LifecycleSegmentState {
    let segment = segments.get(index);
    if (!segment) {
      segment = {
        index,
        command: input.commands[index - 1] ?? "",
        cwd: input.cwd,
        startedAt: Date.now(),
        stdoutClosed: false,
        stderrClosed: false,
        stdout: "",
        stderr: "",
        exitCode: null,
      };
      segments.set(index, segment);
      order.push(index);
    }
    return segment;
  }

  function maybeCompleted(index: number): WorktreeSetupCommandProgressEvent | null {
    const segment = segments.get(index);
    if (!segment || !segment.stdoutClosed || !segment.stderrClosed) {
      return null;
    }
    return {
      type: "command_completed",
      index,
      total,
      command: segment.command,
      cwd: segment.cwd,
      exitCode: segment.exitCode,
      durationMs: Date.now() - segment.startedAt,
      stdout: segment.stdout,
      stderr: segment.stderr,
    };
  }

  function appendContentLine(
    stream: LifecycleStream,
    index: number,
    line: string,
    events: WorktreeSetupCommandProgressEvent[],
  ): void {
    const segment = getOrCreateSegment(index);
    const textLine = `${line}\n`;
    if (stream === "stdout") {
      segment.stdout += textLine;
    } else {
      segment.stderr += textLine;
    }
    events.push({
      type: "output",
      index,
      total,
      command: segment.command,
      cwd: segment.cwd,
      stream,
      chunk: textLine,
    });
  }

  function flushPendingBlank(
    stream: LifecycleStream,
    events: WorktreeSetupCommandProgressEvent[],
  ): void {
    const isPending = stream === "stdout" ? pendingBlankStdout : pendingBlankStderr;
    if (!isPending) {
      return;
    }
    if (stream === "stdout") {
      pendingBlankStdout = false;
    } else {
      pendingBlankStderr = false;
    }
    const activeIndex = stream === "stdout" ? activeStdoutIndex : activeStderrIndex;
    if (activeIndex === null) {
      // Defensive only — a pending blank can't outlive its segment closing,
      // since the END-marker branch below always clears it first.
      return;
    }
    appendContentLine(stream, activeIndex, "", events);
  }

  function processLine(
    stream: LifecycleStream,
    line: string,
    events: WorktreeSetupCommandProgressEvent[],
  ): void {
    const marker = matchMarkerLine(line, input.markerToken);
    if (marker) {
      if (marker.kind === "start") {
        const segment = getOrCreateSegment(marker.index);
        if (stream === "stdout") {
          activeStdoutIndex = marker.index;
          if (marker.index === lastCompletedIndex + 1) {
            events.push({
              type: "command_started",
              index: segment.index,
              total,
              command: segment.command,
              cwd: segment.cwd,
            });
          } else {
            pendingStartIndices.add(marker.index);
          }
        } else {
          activeStderrIndex = marker.index;
        }
        return;
      }

      // The END marker's own leading guard newline is exactly the blank
      // line we're holding back — discard it instead of flushing it.
      if (stream === "stdout") {
        pendingBlankStdout = false;
      } else {
        pendingBlankStderr = false;
      }

      const segment = getOrCreateSegment(marker.index);
      segment.exitCode = marker.status;
      if (stream === "stdout") {
        segment.stdoutClosed = true;
        activeStdoutIndex = null;
      } else {
        segment.stderrClosed = true;
        activeStderrIndex = null;
      }
      const completed = maybeCompleted(marker.index);
      if (completed) {
        events.push(completed);
        lastCompletedIndex = marker.index;
        const nextIndex = marker.index + 1;
        if (pendingStartIndices.has(nextIndex)) {
          pendingStartIndices.delete(nextIndex);
          const pendingSegment = getOrCreateSegment(nextIndex);
          events.push({
            type: "command_started",
            index: pendingSegment.index,
            total,
            command: pendingSegment.command,
            cwd: pendingSegment.cwd,
          });
        }
      }
      return;
    }

    const activeIndex = stream === "stdout" ? activeStdoutIndex : activeStderrIndex;
    if (activeIndex === null) {
      preamble += `${line}\n`;
      return;
    }

    if (line === "") {
      // Two blanks in a row means the first one was real content, not a
      // guard artifact (there's only ever one guard newline per marker).
      flushPendingBlank(stream, events);
      if (stream === "stdout") {
        pendingBlankStdout = true;
      } else {
        pendingBlankStderr = true;
      }
      return;
    }

    flushPendingBlank(stream, events);
    appendContentLine(stream, activeIndex, line, events);
  }

  function feed(stream: LifecycleStream, chunk: string): WorktreeSetupCommandProgressEvent[] {
    const events: WorktreeSetupCommandProgressEvent[] = [];
    const combined = (stream === "stdout" ? stdoutBuffer : stderrBuffer) + chunk;
    const lines = combined.split("\n");
    const remainder = lines.pop() ?? "";
    if (stream === "stdout") {
      stdoutBuffer = remainder;
    } else {
      stderrBuffer = remainder;
    }
    for (const line of lines) {
      processLine(stream, line, events);
    }
    return events;
  }

  function finalize(finalExitCode: number | null): WorktreeSetupCommandResult[] {
    const discardedEvents: WorktreeSetupCommandProgressEvent[] = [];
    if (stdoutBuffer) {
      processLine("stdout", stdoutBuffer, discardedEvents);
      stdoutBuffer = "";
    }
    if (stderrBuffer) {
      processLine("stderr", stderrBuffer, discardedEvents);
      stderrBuffer = "";
    }
    // Process exited before its next line told us whether these were real
    // content or a guard artifact — treat abrupt termination as real content
    // rather than silently dropping it.
    flushPendingBlank("stdout", discardedEvents);
    flushPendingBlank("stderr", discardedEvents);

    if (order.length === 0) {
      if (total === 0) {
        return [];
      }
      // The shell never reached the first marker at all (e.g. it failed
      // during its own interactive/login startup) — surface that as command
      // 1 failing rather than silently returning an empty (success-shaped)
      // result array.
      return [
        {
          command: input.commands[0] ?? "",
          cwd: input.cwd,
          stdout: "",
          stderr: preamble,
          exitCode: finalExitCode,
          durationMs: 0,
        },
      ];
    }

    return order.map((index) => {
      const segment = segments.get(index);
      if (!segment) {
        throw new Error(`Missing worktree lifecycle segment for index ${index}`);
      }
      if (segment.exitCode === null) {
        segment.exitCode = finalExitCode;
      }
      return {
        command: segment.command,
        cwd: segment.cwd,
        stdout: segment.stdout,
        stderr: segment.stderr,
        exitCode: segment.exitCode,
        durationMs: Date.now() - segment.startedAt,
      };
    });
  }

  return { feed, finalize };
}
