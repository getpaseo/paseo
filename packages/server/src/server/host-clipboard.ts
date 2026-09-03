import type { ChildProcess } from "node:child_process";
import { open, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execCommand, spawnProcess } from "../utils/spawn.js";

export type HostClipboardImageMimeType = "image/png" | "image/jpeg";

export interface HostClipboardWriteImageInput {
  mimeType: HostClipboardImageMimeType;
  dataBase64: string;
}

export interface HostClipboardWriteResult {
  success: boolean;
  error: string | null;
}

// Clipboard images are screenshots pasted into agent TUIs, not file transfers,
// and every strategy below materializes the bytes on disk — refuse anything
// larger than 10 MiB decoded.
const MAX_DECODED_BYTES = 10 * 1024 * 1024;
// Each base64 char encodes 3/4 of a byte; 4*ceil(bytes/3) is the padded
// encoding length, so any longer input must decode past the limit and can be
// rejected before allocating the buffer.
const MAX_BASE64_LENGTH = Math.ceil(MAX_DECODED_BYTES / 3) * 4;
const SIZE_LIMIT_ERROR = `clipboard image too large: limit is ${
  MAX_DECODED_BYTES / (1024 * 1024)
} MiB`;

// A wedged clipboard tool must not hold the RPC open forever.
const CLIPBOARD_TOOL_TIMEOUT_MS = 15_000;

export async function writeImageToHostClipboard(
  input: HostClipboardWriteImageInput,
): Promise<HostClipboardWriteResult> {
  return writeImageToHostClipboardOnPlatform({ ...input, platform: process.platform });
}

export interface HostClipboardWritePlatformInput extends HostClipboardWriteImageInput {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Platform-parametrized variant of {@link writeImageToHostClipboard}; lets
 * tests exercise every OS strategy from any CI machine. Never throws: every
 * failure becomes `{ success: false, error }`.
 */
export async function writeImageToHostClipboardOnPlatform(
  input: HostClipboardWritePlatformInput,
): Promise<HostClipboardWriteResult> {
  const { platform, env = process.env } = input;
  try {
    const bytes = decodeImagePayload(input.dataBase64);
    await withTempImageFile(bytes, input.mimeType, (imagePath) =>
      dispatchPlatformWrite(platform, imagePath, input.mimeType, env),
    );
    return { success: true, error: null };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let tempImagePasteCounter = 0;

/**
 * Materializes a clipboard image under os.tmpdir() and returns its path. Used
 * as a headless fallback when writing the bytes onto the host clipboard fails:
 * the client pastes the returned path as text so path-aware TUIs can attach
 * the image.
 *
 * The file deliberately OUTLIVES this call — there is no reliable completion
 * signal telling us when the TUI has finished reading the image, so we cannot
 * clean up here. The files are small (< 10 MiB) and live in the OS temp dir,
 * which reclaims them on reboot.
 */
export async function materializeClipboardImageToTempFile(
  input: HostClipboardWriteImageInput,
): Promise<{ path: string }> {
  const bytes = decodeImagePayload(input.dataBase64);
  const extension = input.mimeType === "image/png" ? "png" : "jpg";
  const imagePath = join(
    tmpdir(),
    `paseo-image-paste-${Date.now()}-${tempImagePasteCounter++}.${extension}`,
  );
  await writeFile(imagePath, bytes);
  return { path: imagePath };
}

function decodeImagePayload(dataBase64: string): Buffer {
  if (dataBase64.length > MAX_BASE64_LENGTH) {
    throw new Error(SIZE_LIMIT_ERROR);
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.byteLength > MAX_DECODED_BYTES) {
    throw new Error(SIZE_LIMIT_ERROR);
  }
  if (bytes.byteLength === 0) {
    throw new Error("clipboard image payload is empty");
  }
  return bytes;
}

async function withTempImageFile(
  bytes: Buffer,
  mimeType: HostClipboardImageMimeType,
  run: (imagePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-clipboard-"));
  try {
    // Keep a truthful extension: the Windows strategy infers the clipboard
    // format from it.
    const imagePath = join(directory, mimeType === "image/png" ? "image.png" : "image.jpg");
    await writeFile(imagePath, bytes);
    await run(imagePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function dispatchPlatformWrite(
  platform: NodeJS.Platform,
  imagePath: string,
  mimeType: HostClipboardImageMimeType,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  switch (platform) {
    case "darwin":
      return writeToDarwinClipboard(imagePath, mimeType);
    case "linux":
      return writeToLinuxClipboard(imagePath, mimeType, env);
    case "win32":
      return writeToWindowsClipboard(imagePath);
    default:
      return Promise.reject(new Error("clipboard write unsupported on this platform"));
  }
}

async function writeToDarwinClipboard(
  imagePath: string,
  mimeType: HostClipboardImageMimeType,
): Promise<void> {
  // «class PNGf» / «class JPEG picture» are the raw NSPasteboard flavor codes
  // for image data; AppleScript exposes no friendlier named type.
  const flavor = mimeType === "image/png" ? "«class PNGf»" : "«class JPEG picture»";
  // Escape for embedding inside the script's double-quoted string literal:
  // backslashes first, then the quotes themselves.
  const escapedPath = imagePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `set the clipboard to (read (POSIX file "${escapedPath}") as ${flavor})`;
  await runClipboardTool({ command: "osascript", args: ["-e", script] });
}

interface LinuxClipboardTool {
  binary: string;
  invoke: (imagePath: string, mimeType: HostClipboardImageMimeType) => ClipboardToolInvocation;
}

const WL_COPY_TOOL: LinuxClipboardTool = {
  binary: "wl-copy",
  invoke: (imagePath, mimeType) => ({
    command: "wl-copy",
    args: ["-t", mimeType],
    stdinFile: imagePath,
  }),
};

const XCLIP_TOOL: LinuxClipboardTool = {
  binary: "xclip",
  invoke: (imagePath, mimeType) => ({
    command: "xclip",
    args: ["-selection", "clipboard", "-t", mimeType, "-i", imagePath],
  }),
};

async function writeToLinuxClipboard(
  imagePath: string,
  mimeType: HostClipboardImageMimeType,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // Prefer the tool matching the session type, fall back to the other one:
  // XWayland makes xclip work on most Wayland desktops too.
  const tools = env.WAYLAND_DISPLAY ? [WL_COPY_TOOL, XCLIP_TOOL] : [XCLIP_TOOL, WL_COPY_TOOL];
  const failures: string[] = [];
  for (const tool of tools) {
    if (!(await isCommandAvailable(tool.binary))) {
      continue;
    }
    try {
      await runClipboardTool(tool.invoke(imagePath, mimeType));
      return;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    failures.length > 0
      ? failures.join("; ")
      : "no clipboard tool available on the host; install wl-clipboard (wl-copy) or xclip",
  );
}

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execCommand("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function writeToWindowsClipboard(imagePath: string): Promise<void> {
  // PowerShell single-quoted strings escape an embedded quote by doubling it.
  const quotedPath = imagePath.replace(/'/g, "''");
  await runClipboardTool({
    command: "powershell",
    args: ["-NoProfile", "-Command", `Set-Clipboard -Path '${quotedPath}'`],
  });
}

interface ClipboardToolInvocation {
  command: string;
  args: string[];
  /** File whose contents are piped to the tool's stdin. */
  stdinFile?: string;
}

async function runClipboardTool(invocation: ClipboardToolInvocation): Promise<void> {
  const stdinHandle = invocation.stdinFile ? await open(invocation.stdinFile, "r") : null;
  try {
    const child = spawnProcess(invocation.command, invocation.args, {
      // Direct argv execution everywhere: no shell means no second layer of
      // quoting to get wrong (notably PowerShell on cmd.exe).
      shell: false,
      stdio: stdinHandle ? [stdinHandle.fd, "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    await waitForChildExit(child, invocation.command);
  } finally {
    await stdinHandle?.close();
  }
}

function waitForChildExit(child: ChildProcess, command: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    // Either event source may fire first (a failed spawn emits "error" then
    // "close"); only the first observation settles the race.
    const finish = (error: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CLIPBOARD_TOOL_TIMEOUT_MS);
    timer.unref();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Drain stdout so a chatty tool cannot stall on a full pipe buffer.
    child.stdout?.on("data", () => {});
    child.once("error", (error) => {
      finish(
        new Error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    });
    // Settle on "exit", not "close": wl-copy and xclip fork a grandchild that
    // keeps owning the clipboard selection and inherits our stdout/stderr
    // pipes, so the streams never close while the selection is alive. Waiting
    // for stream closure would hang every Linux write until the timeout and
    // then kill a process that already exited.
    child.once("exit", (code) => {
      // Release whatever pipes remain; the selection owner still holds them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (code === 0) {
        finish(null);
        return;
      }
      const detail = stderr.trim();
      finish(
        detail
          ? new Error(`${command} failed: ${detail}`)
          : new Error(`${command} failed with exit code ${code ?? "unknown"}`),
      );
    });
  });
}
