import { stat } from "node:fs/promises";
import { sep } from "node:path";
import type { ChildProcess } from "node:child_process";
import type {
  WorkspaceContentMatch,
  WorkspaceContentSearchResult,
} from "@getpaseo/protocol/messages";
import { readExplorerFileBytes } from "../file-explorer/service.js";
import { spawnProcess } from "../../utils/spawn.js";
import { toWorkspaceRelativePath } from "../path-utils.js";

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
  if (!input.query)
    return { status: "ok", matches: [], limited: false, maxFileBytes: MAX_FILE_BYTES };
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
    const timedOut = () => {
      error = failure("timeout", "Search timed out — refine your query or retry");
      stop();
    };
    // Reading and converting each matched file is synchronous work between ticks, so the timer
    // alone cannot end an operation that overruns inside it. Conversion checks the same deadline
    // directly, and the budget covers the whole operation rather than only its search.
    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    const timeout = setTimeout(timedOut, options.timeoutMs ?? 5000);
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
            pendingPath = workspacePathFromRg(event.data.path?.text);
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
          located = await locateMatches(input.cwd, matches.slice(0, MAX_RESULTS), () => {
            if (!error && Date.now() >= deadline) timedOut();
            return !!error;
          });
      } catch {
        error ??= failure("unavailable", "Files changed while searching — retry");
      }
      cleanup();
      resolve(error ?? { status: "ok", matches: located, limited, maxFileBytes: MAX_FILE_BYTES });
    });
  });
}

/** rg reports paths under the "." root using this host's separator; identities cross the wire
 * with "/" so a client never has to guess which character was a separator. */
function workspacePathFromRg(reported: string | undefined): string {
  if (!reported) return "";
  const relative = reported.startsWith(`.${sep}`) ? reported.slice(2) : reported;
  return toWorkspaceRelativePath(relative);
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

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * Walks a file's saved bytes once, handing out each occurrence's source line and UTF-16 column.
 *
 * rg counts LF records while source views count CR, CRLF and LF lines, so the offsets it reports
 * have to be translated. Doing that by decoding and splitting everything before each occurrence
 * costs the whole file per match: a million-line file with 200 matches blocked for about six
 * seconds and answered after its own deadline. Occurrences arrive in ascending offset order, so a
 * single forward cursor answers all of them, and each line is decoded once however many matches
 * it holds.
 */
function createLineReader(bytes: Uint8Array) {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  // A leading byte-order mark is not part of the first line's text and is not counted in its
  // columns. Stripping it once here keeps every later decode positional.
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let cursor = start;
  let line = 1;
  let lineStart = start;
  let lineEnd = -1;
  let lineText = "";
  let columnByte = 0;
  let column = 0;

  function endOfLine(from: number): number {
    let index = from;
    while (index < bytes.length && bytes[index] !== LINE_FEED && bytes[index] !== CARRIAGE_RETURN) {
      index += 1;
    }
    return index;
  }

  return function read(byteOffset: number) {
    while (cursor < byteOffset) {
      const byte = bytes[cursor];
      cursor += 1;
      if (byte === CARRIAGE_RETURN && bytes[cursor] === LINE_FEED && cursor < byteOffset) {
        cursor += 1;
      } else if (byte !== CARRIAGE_RETURN && byte !== LINE_FEED) {
        continue;
      }
      line += 1;
      lineStart = cursor;
      lineEnd = -1;
    }
    if (lineEnd === -1) {
      lineEnd = endOfLine(lineStart);
      lineText = decoder.decode(bytes.subarray(lineStart, lineEnd));
      columnByte = lineStart;
      column = 0;
    }
    // Matches on one line arrive in order, so the column advances from the previous one rather
    // than being recounted from the start of the line.
    if (byteOffset > columnByte) {
      column += decoder.decode(bytes.subarray(columnByte, byteOffset)).length;
      columnByte = byteOffset;
    }
    return { line, column, lineText };
  };
}

/** Read each matched file once through the bounded/revision-checked producer to translate original
 * byte offsets. A file changed during the search must not manufacture an occurrence. */
async function locateMatches(
  cwd: string,
  matches: RgMatch[],
  stopped: () => boolean,
): Promise<WorkspaceContentMatch[]> {
  const located: WorkspaceContentMatch[] = [];
  let path = "";
  let bytes: Uint8Array = new Uint8Array();
  let valid = false;
  let read = createLineReader(bytes);
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
      read = createLineReader(bytes);
    }
    if (!valid) continue;
    const end = byteOffset + Buffer.byteLength(match.text);
    if (
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(byteOffset, end)) !==
      match.text
    )
      continue;
    const { line, column, lineText } = read(byteOffset);
    const snippetStart = Math.max(0, column - 80);
    const snippet = lineText.slice(snippetStart, snippetStart + 240);
    located.push({
      ...match,
      line,
      columnStart: column + 1,
      columnEnd: column + match.text.length + 1,
      snippet,
      snippetMatchStart: column - snippetStart,
      snippetMatchEnd: Math.min(column + match.text.length - snippetStart, snippet.length),
    });
  }
  return located;
}
