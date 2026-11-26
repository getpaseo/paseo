using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// PowerShell's Windows argument mode rewrites .cmd arguments before the batch
// file starts. This exe reads the raw command line and forwards it unchanged.
static class Program
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetCommandLineW();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    const int StartfUseStdHandles = 0x00000100;
    const uint HandleFlagInherit = 0x00000001;
    const int StdInputHandle = -10;
    const int StdOutputHandle = -11;
    const int StdErrorHandle = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
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
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    const uint Infinite = 0xFFFFFFFF;

    static int Main()
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string binDir = Path.GetDirectoryName(self);
        string targetFile = Path.Combine(binDir, "paseo.target");
        string tail = TailAfterArgv0(Marshal.PtrToStringUni(GetCommandLineW()) ?? "");
        if (File.Exists(targetFile))
        {
            string target = File.ReadAllText(targetFile).Trim();
            if (target.Length == 0 || !File.Exists(target))
            {
                Console.Error.WriteLine("Paseo CLI not found at " + target + " - is Paseo installed?");
                return 1;
            }
            string fullTarget = Path.GetFullPath(target);
            if (string.Equals(fullTarget, Path.GetFullPath(self), StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine("Paseo CLI target points at itself: " + fullTarget);
                return 1;
            }
            return Run(fullTarget, JoinCommand(Quote(fullTarget), tail));
        }

        string resourcesDir = Path.GetFullPath(Path.Combine(binDir, ".."));
        string appExe = Path.GetFullPath(Path.Combine(resourcesDir, "..", "Paseo.exe"));
        if (!File.Exists(appExe))
        {
            Console.Error.WriteLine("Bundled Paseo executable not found at " + appExe);
            return 1;
        }

        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");
        Environment.SetEnvironmentVariable("PASEO_NODE_ENV", "production");
        Environment.SetEnvironmentVariable("PASEO_CLI", self);
        string runner = Path.Combine(resourcesDir, "app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js");
        string cli = Path.Combine(resourcesDir, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js");
        string command = JoinCommand(
            Quote(appExe) + " --disable-warning=DEP0040 " + Quote(runner) + " node-script " + Quote(cli),
            tail);
        return Run(appExe, command);
    }

    static IntPtr InheritableStandardHandle(int kind)
    {
        IntPtr handle = GetStdHandle(kind);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return handle;
        SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit);
        return handle;
    }

    static string JoinCommand(string command, string tail)
    {
        if (tail.Length == 0) return command;
        return command + " " + tail;
    }

    static int Run(string application, string commandLine)
    {
        if (commandLine.Length >= 32767)
        {
            Console.Error.WriteLine("Paseo CLI command line is too long for Windows");
            return 1;
        }

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        // Paseo.exe is a GUI-subsystem binary. Without STARTF_USESTDHANDLES it
        // ignores the parent's redirected pipes and AttachConsole writes to the
        // console instead, so `paseo --version > out.txt` loses its output.
        startup.dwFlags = StartfUseStdHandles;
        startup.hStdInput = InheritableStandardHandle(StdInputHandle);
        startup.hStdOutput = InheritableStandardHandle(StdOutputHandle);
        startup.hStdError = InheritableStandardHandle(StdErrorHandle);
        PROCESS_INFORMATION process;
        StringBuilder mutable = new StringBuilder(commandLine, commandLine.Length + 1);
        bool created = CreateProcessW(
            application,
            mutable,
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            0,
            IntPtr.Zero,
            null,
            ref startup,
            out process);
        if (!created)
        {
            Console.Error.WriteLine("Paseo CLI failed to start " + application + " (Win32 " + Marshal.GetLastWin32Error() + ")");
            return 1;
        }

        try
        {
            WaitForSingleObject(process.hProcess, Infinite);
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) return 1;
            return unchecked((int)exitCode);
        }
        finally
        {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
    }

    static string TailAfterArgv0(string commandLine)
    {
        int index = 0;
        int length = commandLine.Length;
        if (length == 0) return "";
        if (commandLine[0] == '"')
        {
            index = 1;
            while (index < length && commandLine[index] != '"') index++;
            if (index < length) index++;
        }
        else
        {
            while (index < length && !IsCommandWhitespace(commandLine[index])) index++;
        }
        while (index < length && IsCommandWhitespace(commandLine[index])) index++;
        return commandLine.Substring(index);
    }

    static bool IsCommandWhitespace(char value)
    {
        return value == ' ' || value == '\t';
    }

    static string Quote(string value)
    {
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int index = 0;
        while (index < value.Length)
        {
            int backslashes = 0;
            while (index < value.Length && value[index] == '\\')
            {
                backslashes++;
                index++;
            }
            if (index == value.Length)
            {
                quoted.Append('\\', backslashes * 2);
                break;
            }
            if (value[index] == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
            }
            else
            {
                quoted.Append('\\', backslashes);
                quoted.Append(value[index]);
            }
            index++;
        }
        quoted.Append('"');
        return quoted.ToString();
    }
}
