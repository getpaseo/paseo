import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createExternalProcessEnv, type ProcessEnvRecord } from "../../../paseo-env.js";
import { spawnProcess, type SpawnProcessOptions } from "../../../../utils/spawn.js";

const WINDOWS_JOB_COMMAND_ENV = "PASEO_WINDOWS_JOB_COMMAND";
const WINDOWS_JOB_COMMAND_LINE_ENV = "PASEO_WINDOWS_JOB_COMMAND_LINE";
const WINDOWS_JOB_PROOF_ENV = "PASEO_WINDOWS_JOB_PROOF";
const WINDOWS_JOB_PROOF_PREFIX = "PASEO_WINDOWS_JOB_EMPTY:";
const proofMarkers = new WeakMap<ChildProcess, string>();

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
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    public static int Run(string applicationName, string commandLine)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr nullInput = IntPtr.Zero;
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
            nullInput = CreateFileW(
                "NUL",
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref security,
                OPEN_EXISTING,
                0,
                IntPtr.Zero);
            CheckHandle(nullInput, "CreateFile(NUL)");

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = nullInput;
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
            CloseHandle(nullInput);
            nullInput = IntPtr.Zero;

            Task<string> control = Console.In.ReadLineAsync();
            while (true)
            {
                uint wait = WaitForSingleObject(job, 50);
                if (wait == WAIT_OBJECT_0)
                {
                    break;
                }
                if (wait != WAIT_TIMEOUT)
                {
                    ThrowLastError("WaitForSingleObject(job)");
                }
                if (control.IsCompleted)
                {
                    string request = control.Result;
                    if (request == null || String.Equals(request, "terminate", StringComparison.Ordinal))
                    {
                        if (!TerminateJobObject(job, 1))
                        {
                            ThrowLastError("TerminateJobObject");
                        }
                        if (WaitForSingleObject(job, INFINITE) != WAIT_OBJECT_0)
                        {
                            ThrowLastError("WaitForSingleObject(terminated job)");
                        }
                        break;
                    }
                    control = Console.In.ReadLineAsync();
                }
            }

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
                TerminateJobObject(job, 1);
                WaitForSingleObject(job, INFINITE);
            }
            else if (process.hProcess != IntPtr.Zero)
            {
                TerminateProcess(process.hProcess, 1);
                WaitForSingleObject(process.hProcess, INFINITE);
            }
            throw;
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (nullInput != IntPtr.Zero && nullInput != INVALID_HANDLE_VALUE) CloseHandle(nullInput);
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
Remove-Item Env:${WINDOWS_JOB_COMMAND_ENV}
Remove-Item Env:${WINDOWS_JOB_COMMAND_LINE_ENV}
Remove-Item Env:${WINDOWS_JOB_PROOF_ENV}
$exitCode = [PaseoWindowsJobSupervisor]::Run($applicationName, $commandLine)
[Console]::Out.WriteLine("${WINDOWS_JOB_PROOF_PREFIX}" + $proof)
[Console]::Out.Flush()
exit $exitCode
`;

const WINDOWS_JOB_ENCODED_COMMAND = Buffer.from(WINDOWS_JOB_SUPERVISOR, "utf16le").toString(
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
    const commandLine = [command, ...args].map(quoteCreateProcessArgument).join(" ");
    const proof = randomUUID();

    const supervisor = spawnChild(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_JOB_ENCODED_COMMAND],
      {
        ...spawnOptions,
        env: targetEnv,
        envMode: "internal",
        envOverlay: {
          [WINDOWS_JOB_COMMAND_ENV]: command,
          [WINDOWS_JOB_COMMAND_LINE_ENV]: Buffer.from(commandLine, "utf8").toString("base64"),
          [WINDOWS_JOB_PROOF_ENV]: proof,
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    proofMarkers.set(supervisor, `${WINDOWS_JOB_PROOF_PREFIX}${proof}`);
    return supervisor;
  };
}

export const spawnWindowsJobObjectProcess = createWindowsJobObjectProcessSpawner();

export function getWindowsJobObjectProofMarker(process: ChildProcess): string | undefined {
  return proofMarkers.get(process);
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
