import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { gzipSync } from "node:zlib";

import { createExternalProcessEnv, type ProcessEnvRecord } from "../../../paseo-env.js";
import { spawnProcess, type SpawnProcessOptions } from "../../../../utils/spawn.js";
import type { TreeKillTarget } from "../../../../utils/tree-kill.js";

const WINDOWS_JOB_COMMAND_ENV = "PASEO_WINDOWS_JOB_COMMAND";
const WINDOWS_JOB_COMMAND_LINE_ENV = "PASEO_WINDOWS_JOB_COMMAND_LINE";
const WINDOWS_JOB_PROOF_ENV = "PASEO_WINDOWS_JOB_PROOF";
const WINDOWS_JOB_PROOF_PREFIX = "PASEO_WINDOWS_JOB_EMPTY:";
const WINDOWS_JOB_TERMINATE_PREFIX = "PASEO_WINDOWS_JOB_TERMINATE:";
const WINDOWS_JOB_LEADER_EXIT_PREFIX = "PASEO_WINDOWS_JOB_LEADER_EXIT:";
const WINDOWS_COMMAND_HOST_COMMAND_ENV = "PASEO_WINDOWS_COMMAND_HOST_COMMAND";
const WINDOWS_COMMAND_HOST_ARG_COUNT_ENV = "PASEO_WINDOWS_COMMAND_HOST_ARG_COUNT";
const WINDOWS_COMMAND_HOST_ARG_PREFIX = "PASEO_WINDOWS_COMMAND_HOST_ARG_";

interface WindowsJobObjectMetadata {
  proofMarker: string;
  leaderExitMarker: string;
  terminationRequest: string;
  completion: Promise<boolean>;
  leaderExit: Promise<number>;
}

const windowsJobMetadata = new WeakMap<ChildProcess, WindowsJobObjectMetadata>();

const WINDOWS_COMMAND_HOST = String.raw`
$ErrorActionPreference = "Stop"
$command = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:${WINDOWS_COMMAND_HOST_COMMAND_ENV})
)
$argCount = [int]$env:${WINDOWS_COMMAND_HOST_ARG_COUNT_ENV}
[Environment]::SetEnvironmentVariable("${WINDOWS_COMMAND_HOST_COMMAND_ENV}", $null)
[Environment]::SetEnvironmentVariable("${WINDOWS_COMMAND_HOST_ARG_COUNT_ENV}", $null)
$targetArgs = [System.Collections.Generic.List[string]]::new()
for ($index = 0; $index -lt $argCount; $index++) {
  $name = "${WINDOWS_COMMAND_HOST_ARG_PREFIX}" + $index
  $encoded = [Environment]::GetEnvironmentVariable($name)
  [Environment]::SetEnvironmentVariable($name, $null)
  $targetArgs.Add([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)))
}
try {
  & $command @targetArgs
  if ($null -eq $LASTEXITCODE) { exit 0 }
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

const WINDOWS_COMMAND_HOST_ENCODED_COMMAND = Buffer.from(WINDOWS_COMMAND_HOST, "utf16le").toString(
  "base64",
);

const WINDOWS_JOB_SUPERVISOR = String.raw`
$ErrorActionPreference = "Stop"
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class PaseoWindowsJobSupervisor
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint INFINITE = 0xffffffff;
    private const uint STILL_ACTIVE = 259;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;

    public static bool LastRunProvedEmpty { get; private set; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        IntPtr file,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        IntPtr overlapped);

    public static int Run(
        string applicationName,
        string commandLine,
        string proof,
        string terminationRequest)
    {
        LastRunProvedEmpty = false;
        IntPtr job = IntPtr.Zero;
        IntPtr targetInputRead = IntPtr.Zero;
        IntPtr targetInputWrite = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool assigned = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            CheckHandle(job, "CreateJobObject");

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                ThrowLastError("SetInformationJobObject");
            }

            SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
            security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            security.bInheritHandle = 1;
            if (!CreatePipe(out targetInputRead, out targetInputWrite, ref security, 0))
            {
                ThrowLastError("CreatePipe(target stdin)");
            }
            if (!SetHandleInformation(targetInputWrite, HANDLE_FLAG_INHERIT, 0))
            {
                ThrowLastError("SetHandleInformation(target stdin)");
            }

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = targetInputRead;
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);
            if (!CreateProcessW(
                applicationName,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED,
                IntPtr.Zero,
                null,
                ref startup,
                out process))
            {
                ThrowLastError("CreateProcess");
            }
            CloseHandle(targetInputRead);
            targetInputRead = IntPtr.Zero;
            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                ThrowLastError("AssignProcessToJobObject");
            }
            assigned = true;
            if (ResumeThread(process.hThread) == 0xffffffff)
            {
                ThrowLastError("ResumeThread");
            }
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;

            Task<string> control = Console.In.ReadLineAsync();
            bool leaderExited = false;
            while (true)
            {
                uint wait = WaitForSingleObject(job, 10);
                if (wait == WAIT_OBJECT_0)
                {
                    break;
                }
                if (wait != WAIT_TIMEOUT)
                {
                    ThrowLastError("WaitForSingleObject(job)");
                }
                if (!leaderExited)
                {
                    uint leaderWait = WaitForSingleObject(process.hProcess, 0);
                    if (leaderWait == WAIT_OBJECT_0)
                    {
                        uint leaderExitCode;
                        if (!GetExitCodeProcess(process.hProcess, out leaderExitCode) ||
                            leaderExitCode == STILL_ACTIVE)
                        {
                            ThrowLastError("GetExitCodeProcess(leader)");
                        }
                        leaderExited = true;
                        if (targetInputWrite != IntPtr.Zero)
                        {
                            CloseHandle(targetInputWrite);
                            targetInputWrite = IntPtr.Zero;
                        }
                        Console.Error.WriteLine(
                            "${WINDOWS_JOB_LEADER_EXIT_PREFIX}" + proof + ":" + leaderExitCode);
                        Console.Error.Flush();
                    }
                    else if (leaderWait != WAIT_TIMEOUT)
                    {
                        ThrowLastError("WaitForSingleObject(leader)");
                    }
                }
                bool terminationRequested = false;
                while (control.IsCompleted)
                {
                    string request = control.Result;
                    if (request == null ||
                        String.Equals(request, terminationRequest, StringComparison.Ordinal))
                    {
                        if (targetInputWrite != IntPtr.Zero)
                        {
                            CloseHandle(targetInputWrite);
                            targetInputWrite = IntPtr.Zero;
                        }
                        if (!TerminateJobObject(job, 1))
                        {
                            ThrowLastError("TerminateJobObject");
                        }
                        if (WaitForSingleObject(job, INFINITE) != WAIT_OBJECT_0)
                        {
                            ThrowLastError("WaitForSingleObject(terminated job)");
                        }
                        terminationRequested = true;
                        break;
                    }
                    if (!leaderExited)
                    {
                        byte[] input = new UTF8Encoding(false).GetBytes(request + "\n");
                        uint written;
                        if (!WriteFile(
                            targetInputWrite,
                            input,
                            (uint)input.Length,
                            out written,
                            IntPtr.Zero) || written != (uint)input.Length)
                        {
                            ThrowLastError("WriteFile(target stdin)");
                        }
                    }
                    control = Console.In.ReadLineAsync();
                }
                if (terminationRequested)
                {
                    break;
                }
            }

            LastRunProvedEmpty = true;
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode) || exitCode == STILL_ACTIVE)
            {
                ThrowLastError("GetExitCodeProcess");
            }
            return unchecked((int)exitCode);
        }
        catch
        {
            if (assigned)
            {
                if (!TerminateJobObject(job, 1))
                {
                    ThrowLastError("TerminateJobObject(cleanup)");
                }
                if (WaitForSingleObject(job, INFINITE) != WAIT_OBJECT_0)
                {
                    ThrowLastError("WaitForSingleObject(cleanup job)");
                }
                LastRunProvedEmpty = true;
            }
            else if (process.hProcess != IntPtr.Zero)
            {
                if (!TerminateProcess(process.hProcess, 1))
                {
                    ThrowLastError("TerminateProcess(cleanup)");
                }
                if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0)
                {
                    ThrowLastError("WaitForSingleObject(cleanup process)");
                }
                LastRunProvedEmpty = true;
            }
            else
            {
                LastRunProvedEmpty = true;
            }
            throw;
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (targetInputRead != IntPtr.Zero) CloseHandle(targetInputRead);
            if (targetInputWrite != IntPtr.Zero) CloseHandle(targetInputWrite);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static void CheckHandle(IntPtr handle, string operation)
    {
        if (handle == IntPtr.Zero || handle == INVALID_HANDLE_VALUE) ThrowLastError(operation);
    }

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
}
'@
Add-Type -TypeDefinition $source
$applicationName = $env:${WINDOWS_JOB_COMMAND_ENV}
$commandLine = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:${WINDOWS_JOB_COMMAND_LINE_ENV})
)
$proof = $env:${WINDOWS_JOB_PROOF_ENV}
$terminationRequest = "${WINDOWS_JOB_TERMINATE_PREFIX}" + $proof
Remove-Item Env:${WINDOWS_JOB_COMMAND_ENV}
Remove-Item Env:${WINDOWS_JOB_COMMAND_LINE_ENV}
Remove-Item Env:${WINDOWS_JOB_PROOF_ENV}
$exitCode = 1
try {
  $exitCode = [PaseoWindowsJobSupervisor]::Run(
    $applicationName,
    $commandLine,
    $proof,
    $terminationRequest
  )
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
}
if ([PaseoWindowsJobSupervisor]::LastRunProvedEmpty) {
  [Console]::Error.WriteLine("${WINDOWS_JOB_PROOF_PREFIX}" + $proof)
  [Console]::Error.Flush()
}
exit $exitCode
`;

const WINDOWS_JOB_SUPERVISOR_GZIP = gzipSync(Buffer.from(WINDOWS_JOB_SUPERVISOR, "utf8")).toString(
  "base64",
);
const WINDOWS_JOB_BOOTSTRAP = String.raw`
$compressed = [Convert]::FromBase64String("${WINDOWS_JOB_SUPERVISOR_GZIP}")
$input = [IO.MemoryStream]::new($compressed)
$gzip = [IO.Compression.GzipStream]::new(
  $input,
  [IO.Compression.CompressionMode]::Decompress
)
$reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
$script = $reader.ReadToEnd()
$reader.Dispose()
$gzip.Dispose()
$input.Dispose()
& ([ScriptBlock]::Create($script))
`;
const WINDOWS_JOB_ENCODED_COMMAND = Buffer.from(WINDOWS_JOB_BOOTSTRAP, "utf16le").toString(
  "base64",
);

export type WindowsJobObjectChildSpawner = (
  command: string,
  args: string[],
  options: SpawnProcessOptions,
) => ChildProcess;

export function createWindowsJobObjectProcessSpawner(
  spawnChild: WindowsJobObjectChildSpawner = spawnProcess,
): WindowsJobObjectChildSpawner {
  return (command, args, options) => {
    const { baseEnv, env, envOverlay, ...spawnOptions } = options;
    const resolvedBaseEnv = env ?? baseEnv ?? process.env;
    const targetEnv = resolveTargetEnvironment(options.envMode, resolvedBaseEnv, envOverlay);
    const target = resolveWindowsJobTarget(command, args);
    const commandLine = [target.command, ...target.args].map(quoteCreateProcessArgument).join(" ");
    const proof = randomUUID();
    const proofMarker = `${WINDOWS_JOB_PROOF_PREFIX}${proof}`;
    const leaderExitMarker = `${WINDOWS_JOB_LEADER_EXIT_PREFIX}${proof}:`;
    const terminationRequest = `${WINDOWS_JOB_TERMINATE_PREFIX}${proof}`;

    const supervisor = spawnChild(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_JOB_ENCODED_COMMAND],
      {
        ...spawnOptions,
        env: { ...targetEnv, ...target.envOverlay },
        envMode: "internal",
        envOverlay: {
          [WINDOWS_JOB_COMMAND_ENV]: target.command,
          [WINDOWS_JOB_COMMAND_LINE_ENV]: Buffer.from(commandLine, "utf8").toString("base64"),
          [WINDOWS_JOB_PROOF_ENV]: proof,
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const observation = observeWindowsJob(supervisor, proofMarker, leaderExitMarker);
    windowsJobMetadata.set(supervisor, {
      proofMarker,
      leaderExitMarker,
      terminationRequest,
      completion: observation.completion,
      leaderExit: observation.leaderExit,
    });
    return supervisor;
  };
}

export const spawnWindowsJobObjectProcess = createWindowsJobObjectProcessSpawner();

export function getWindowsJobObjectProofMarker(process: ChildProcess): string | undefined {
  return windowsJobMetadata.get(process)?.proofMarker;
}

export function getWindowsJobObjectCompletion(process: ChildProcess): Promise<boolean> | undefined {
  return windowsJobMetadata.get(process)?.completion;
}

export function getWindowsJobObjectLeaderExit(process: ChildProcess): Promise<number> | undefined {
  return windowsJobMetadata.get(process)?.leaderExit;
}

export function getWindowsJobObjectLeaderExitMarker(process: ChildProcess): string | undefined {
  return windowsJobMetadata.get(process)?.leaderExitMarker;
}

export function createWindowsJobObjectTerminationTarget(process: ChildProcess): TreeKillTarget {
  const terminationRequest = windowsJobMetadata.get(process)?.terminationRequest ?? "terminate";
  return {
    get exitCode() {
      return process.exitCode;
    },
    get signalCode() {
      return process.signalCode;
    },
    kill: () => process.stdin?.write(`${terminationRequest}\n`) ?? false,
    once: (event, listener) => process.once(event, listener),
    off: (event, listener) => process.off(event, listener),
  };
}

function resolveTargetEnvironment(
  envMode: SpawnProcessOptions["envMode"],
  baseEnv: ProcessEnvRecord,
  envOverlay: ProcessEnvRecord | undefined,
): ProcessEnvRecord {
  if (envMode === "internal") {
    return { ...baseEnv, ...envOverlay };
  }
  return createExternalProcessEnv(baseEnv, ...(envOverlay ? [envOverlay] : []));
}

function quoteCreateProcessArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) {
    return value;
  }
  const escaped = value
    .replace(/(\\*)"/gu, (_match, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/\\+$/u, (slashes) => `${slashes}${slashes}`);
  return `"${escaped}"`;
}

function resolveWindowsJobTarget(
  command: string,
  args: string[],
): { command: string; args: string[]; envOverlay?: ProcessEnvRecord } {
  const extension = extname(command).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return { command, args };
  }

  const envOverlay: ProcessEnvRecord = {
    [WINDOWS_COMMAND_HOST_COMMAND_ENV]: Buffer.from(command, "utf8").toString("base64"),
    [WINDOWS_COMMAND_HOST_ARG_COUNT_ENV]: String(args.length),
  };
  args.forEach((argument, index) => {
    envOverlay[`${WINDOWS_COMMAND_HOST_ARG_PREFIX}${index}`] = Buffer.from(
      argument,
      "utf8",
    ).toString("base64");
  });
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_COMMAND_HOST_ENCODED_COMMAND,
    ],
    envOverlay,
  };
}

function observeWindowsJob(
  process: ChildProcess,
  proofMarker: string,
  leaderExitMarker: string,
): { completion: Promise<boolean>; leaderExit: Promise<number> } {
  let resolveCompletion: (proven: boolean) => void = () => undefined;
  let resolveLeaderExit: (exitCode: number) => void = () => undefined;
  const completion = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve;
  });
  const leaderExit = new Promise<number>((resolve) => {
    resolveLeaderExit = resolve;
  });
  let proofBuffer = "";
  let proven = false;
  let leaderExitResolved = false;
  process.stderr?.on("data", (data: Buffer | string) => {
    proofBuffer = (proofBuffer + data.toString()).slice(-512);
    if (proofBuffer.includes(proofMarker)) {
      proven = true;
    }
    if (!leaderExitResolved) {
      const markerIndex = proofBuffer.indexOf(leaderExitMarker);
      if (markerIndex >= 0) {
        const exitCodeText = proofBuffer
          .slice(markerIndex + leaderExitMarker.length)
          .match(/^(\d+)/u)?.[1];
        if (exitCodeText !== undefined) {
          leaderExitResolved = true;
          resolveLeaderExit(Number(exitCodeText));
        }
      }
    }
  });
  process.once("close", () => {
    if (!leaderExitResolved) {
      leaderExitResolved = true;
      resolveLeaderExit(process.exitCode ?? 1);
    }
    resolveCompletion(proven);
  });
  return { completion, leaderExit };
}
