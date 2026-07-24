import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

export interface InteractivePasswordProcess {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  env: NodeJS.ProcessEnv;
  execPath: string;
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams | ReturnType<typeof spawn>;

const WINDOWS_READ_HOST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$secure = Read-Host -Prompt $env:PASEO_PASSWORD_PROMPT -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
`.trim();

export function isWindowsElectronRunAsNode(
  processLike: Pick<
    InteractivePasswordProcess,
    "platform" | "versions" | "env" | "execPath"
  > = process,
): boolean {
  if (processLike.platform !== "win32") {
    return false;
  }

  const electronVersion = processLike.versions.electron;
  if (typeof electronVersion === "string" && electronVersion.length > 0) {
    return true;
  }

  const runAsNode = processLike.env.ELECTRON_RUN_AS_NODE;
  if (runAsNode !== "1" && runAsNode !== "true") {
    return false;
  }

  return /(?:^|[\\/])paseo\.exe$/i.test(processLike.execPath);
}

export function isInteractiveTerminal(
  processLike: Pick<InteractivePasswordProcess, "stdin" | "stdout"> = process,
): boolean {
  return Boolean(processLike.stdin.isTTY && processLike.stdout.isTTY);
}

/**
 * Prompt for a password via a Windows console-subsystem child.
 *
 * Packaged desktop CLI runs as GUI-subsystem Electron (`Paseo.exe` +
 * ELECTRON_RUN_AS_NODE). AttachConsole can drive stdout while Node/libuv
 * stdin is unusable for @clack — so we never read process.stdin here.
 */
export async function promptPasswordViaWindowsConsole(
  message: string,
  spawnImpl: SpawnFn = spawn,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawnImpl(
      "powershell.exe",
      ["-NoProfile", "-Command", WINDOWS_READ_HOST_SCRIPT],
      {
        env: {
          ...process.env,
          PASEO_PASSWORD_PROMPT: message,
        },
        stdio: ["inherit", "pipe", "inherit"],
        windowsHide: false,
      },
    );

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`Windows console password prompt terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Windows console password prompt exited with code ${code ?? "null"}`));
        return;
      }
      resolve(stdout.replace(/\r?\n$/, ""));
    });
  });
}

export const PASSWORD_ALTERNATES_DETAILS = [
  "Use one of:",
  "  paseo daemon set-password --password <value>",
  "  PASEO_SET_PASSWORD=<value> paseo daemon set-password",
  "  npx -y @getpaseo/cli daemon set-password",
].join("\n");
