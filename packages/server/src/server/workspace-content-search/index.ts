import { stat } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type {
  WorkspaceContentMatch,
  WorkspaceContentSearchResult,
} from "@getpaseo/protocol/messages";
import { readExplorerFileBytes } from "../file-explorer/service.js";
import { spawnProcess } from "../../utils/spawn.js";

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 4 * MAX_FILE_BYTES;

/** Searches the host's saved files; owns rg and every resource it allocates. */
export async function searchWorkspaceContent(
  input: { cwd: string; query: string; signal?: AbortSignal },
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<WorkspaceContentSearchResult> {
  if (input.signal?.aborted) return failure("cancelled", "Search cancelled");
  if (
    Buffer.byteLength(input.query) > 1024 ||
    ["\0", "\r", "\n"].some((character) => input.query.includes(character))
  ) {
    return failure("invalid_query", "Search text must be one line, up to 1,024 bytes");
  }
  if (!input.query) return { status: "ok", matches: [], limited: false };
  try {
    if (!(await stat(input.cwd)).isDirectory())
      return failure("unavailable", "Workspace directory is unavailable");
  } catch {
    return failure("unavailable", "Workspace directory is unavailable");
  }
  let child: ChildProcess;
  try {
    child = spawnProcess(
      process.platform === "win32" ? "rg.exe" : "rg",
      [
        "--no-config",
        "--json",
        "--fixed-strings",
        "--ignore-case",
        "--hidden",
        "--no-require-git",
        "--glob",
        "!.git",
        "--max-filesize",
        String(MAX_FILE_BYTES),
        "--sort",
        "path",
        "--encoding",
        "none",
        "--",
        input.query,
        ".",
      ],
      { cwd: input.cwd, shell: false, env: options.env, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (cause) {
    return spawnFailure(cause);
  }
  return new Promise((resolve) => {
    const matches: RgMatch[] = [];
    let pending: RgMatch[] = [];
    let pendingPath = "";
    let buffer = Buffer.alloc(0);
    let outputBytes = 0;
    let stderr = "";
    let limited = false;
    let stopped = false;
    let error: WorkspaceContentSearchResult | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      killTimer.unref();
    };
    const abort = () => {
      error = failure("cancelled", "Search cancelled");
      stop();
    };
    const timeout = setTimeout(() => {
      error = failure("timeout", "Search timed out — refine your query or retry");
      stop();
    }, options.timeoutMs ?? 5000);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    child.on("error", (cause) => {
      error ??= spawnFailure(cause);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, 8192);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopped) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        limited = true;
        stop();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while ((end = buffer.indexOf(10)) !== -1) {
        if (stopped) break;
        const record = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        if (record.byteLength > MAX_FILE_BYTES) {
          limited = true;
          stop();
          break;
        }
        try {
          const event = JSON.parse(record.toString("utf8")) as RgEvent;
          if (event.type === "begin") {
            pending = [];
            pendingPath = event.data.path?.text?.replace(/^\.\//, "") ?? "";
          } else if (event.type === "match" && pendingPath) {
            pending.push(
              ...readMatches(
                event.data,
                pendingPath,
                MAX_RESULTS + 1 - matches.length - pending.length,
              ),
            );
          } else if (event.type === "end") {
            // rg may emit matches before discovering a NUL byte later in the file.
            if (event.data.binary_offset == null) matches.push(...pending);
            pending = [];
            if (matches.length > MAX_RESULTS) {
              limited = true;
              stop();
            }
          }
        } catch {
          error = failure("unavailable", "Could not read ripgrep search results");
          stop();
        }
      }
      if (buffer.byteLength > MAX_FILE_BYTES) {
        limited = true;
        stop();
      }
    });
    const cleanup = () => {
      for (const timer of [timeout, killTimer]) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    };
    child.once("close", async (code) => {
      if (!error && !limited && code !== 0 && code !== 1)
        error = failure("unavailable", stderr.trim() || "File search failed");
      let located: WorkspaceContentMatch[] = [];
      try {
        if (!error)
          located = await locateMatches(input.cwd, matches.slice(0, MAX_RESULTS), () => !!error);
      } catch {
        error ??= failure("unavailable", "Files changed while searching — retry");
      }
      cleanup();
      resolve(error ?? { status: "ok", matches: located, limited });
    });
  });
}

interface RgEvent {
  type: string;
  data: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: { start: number; end: number }[];
    binary_offset?: number | null;
    absolute_offset?: number;
  };
}

function readMatches(data: RgEvent["data"], path: string, remaining: number): RgMatch[] {
  if (!data.lines?.text || !data.line_number || remaining <= 0) return [];
  const raw = Buffer.from(data.lines.text);
  return (data.submatches ?? []).slice(0, remaining).map(({ start, end }) => ({
    path,
    byteOffset: (data.absolute_offset ?? 0) + start,
    text: raw.subarray(start, end).toString("utf8"),
  }));
}

function failure(
  code: Extract<WorkspaceContentSearchResult, { status: "error" }>["code"],
  message: string,
): WorkspaceContentSearchResult {
  return { status: "error", code, message };
}
function spawnFailure(cause: unknown): WorkspaceContentSearchResult {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
    ? failure(
        "missing_rg",
        "Install ripgrep on this host and make rg available on its PATH, then retry",
      )
    : failure(
        "unavailable",
        cause instanceof Error ? cause.message : "Could not start file search",
      );
}

interface RgMatch {
  path: string;
  text: string;
  byteOffset: number;
}

/** rg counts LF records; source views count CR, CRLF and LF lines. Read each matched
 * file once through the bounded/revision-checked producer to translate original byte
 * offsets. A file changed during the search must not manufacture an occurrence. */
async function locateMatches(
  cwd: string,
  matches: RgMatch[],
  stopped: () => boolean,
): Promise<WorkspaceContentMatch[]> {
  const located: WorkspaceContentMatch[] = [];
  let path = "";
  let bytes: Uint8Array = new Uint8Array();
  let valid = false;
  for (const { byteOffset, ...match } of matches) {
    if (stopped()) break;
    if (path !== match.path) {
      path = match.path;
      const file = await readExplorerFileBytes({
        root: cwd,
        relativePath: path,
        maxBytes: MAX_FILE_BYTES,
      });
      bytes = file.bytes;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        valid = !bytes.includes(0);
      } catch {
        valid = false;
      }
    }
    if (!valid) continue;
    const end = byteOffset + Buffer.byteLength(match.text);
    if (
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(byteOffset, end)) !==
      match.text
    )
      continue;
    const prefix = new TextDecoder().decode(bytes.subarray(0, byteOffset)).split(/\r\n|\r|\n/);
    const column = prefix[prefix.length - 1].length;
    const line =
      prefix[prefix.length - 1] +
      new TextDecoder("utf-8", { ignoreBOM: true })
        .decode(bytes.subarray(byteOffset))
        .split(/\r\n|\r|\n/, 1)[0];
    const snippetStart = Math.max(0, column - 80);
    const snippet = line.slice(snippetStart, snippetStart + 240);
    located.push({
      ...match,
      line: prefix.length,
      columnStart: column + 1,
      columnEnd: column + match.text.length + 1,
      snippet,
      snippetMatchStart: column - snippetStart,
      snippetMatchEnd: Math.min(column + match.text.length - snippetStart, snippet.length),
    });
  }
  return located;
}
