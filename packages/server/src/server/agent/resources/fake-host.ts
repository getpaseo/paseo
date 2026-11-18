import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { ResourceHostCommandError, type HostCommand, type ResourceHost } from "./host.js";

const MANAGER_CGROUP = "/user.slice/user-1000.slice/user@1000.service";

export interface FakeCommandFailure {
  /** Matched against any argument of a systemd call. */
  argument: string;
  stderr: string;
  /** How many matching calls fail; every one when absent. */
  times?: number;
}

export interface FakeResourceHostOptions {
  platform?: NodeJS.Platform;
  systemd?: boolean;
  /** Which `nice` is installed: GNU coreutils by default, BusyBox, or none. */
  nice?: "gnu" | "busybox" | false;
  /** The daemon may raise priority, as with CAP_SYS_NICE. Off by default, as for a user. */
  mayRaisePriority?: boolean;
  controllers?: string;
  /** errno every setpriority call fails with. */
  setPriorityError?: string;
  commandFailure?: FakeCommandFailure;
  /** The CPUs the manager's cgroup has, as the kernel lists them. */
  availableCpus?: string;
  /** The CPUs the kernel lets an agent slice use, whatever it asked for. */
  effectiveCpus?: string;
  /** ActiveState answers before `active`, as a start queued behind another job shows. */
  activationStates?: string[];
}

export interface FakeResourceHost extends ResourceHost {
  /** argv of every systemd command run, in order. */
  commands: string[][];
  /** Every systemd command run, with the extra environment it was given. */
  calls: HostCommand[];
  priorities: Map<number, number>;
  /** Single-threaded processes visible in /proc, children of the daemon. */
  processes: Set<number>;
  files: Map<string, string>;
  /** Makes systemd calls containing `argument` fail from now on, or succeed again. */
  failCommands(failure: FakeCommandFailure | null): void;
}

function systemError(errno: string): Error {
  // The shape `os.setPriority` throws: the errno is under `info`, not `code`.
  return Object.assign(new Error(`uv_os_setpriority returned ${errno}`), {
    code: "ERR_SYSTEM_ERROR",
    info: { code: errno, syscall: "uv_os_setpriority" },
  });
}

/**
 * A host with a systemd user manager and cgroup v2, or without them, for tests that
 * cannot depend on the machine they run on. It answers the busctl, systemctl and nice
 * calls agent resources make, records them, and fails the way Node, systemd and the
 * kernel do.
 */
export function createFakeResourceHost(options: FakeResourceHostOptions = {}): FakeResourceHost {
  const files = new Map<string, string>();
  const priorities = new Map<number, number>();
  const calls: HostCommand[] = [];
  const commands: string[][] = [];
  const processes = new Set<number>();
  let failure = options.commandFailure ? { ...options.commandFailure } : null;
  const activationStates = [...(options.activationStates ?? [])];
  const systemd = options.systemd !== false;
  if (systemd) {
    files.set(
      `/sys/fs/cgroup${MANAGER_CGROUP}/cgroup.controllers`,
      options.controllers ?? "cpuset cpu memory pids",
    );
    if (options.availableCpus !== undefined) {
      files.set(`/sys/fs/cgroup${MANAGER_CGROUP}/cpuset.cpus.effective`, options.availableCpus);
    }
  }
  const cgroupFor = (unit: string) => `${MANAGER_CGROUP}/app.slice/${unit}`;

  function runNice(command: string, args: string[]): string {
    const adjustment = Number(args[1]);
    if (adjustment < 0 && !options.mayRaisePriority) {
      if (options.nice === "busybox") {
        throw new ResourceHostCommandError(command, "nice: setpriority: Permission denied");
      }
      return "0\n";
    }
    return `${adjustment}\n`;
  }

  function shouldFail(args: string[]): string | null {
    if (!failure || !args.includes(failure.argument)) {
      return null;
    }
    const { stderr } = failure;
    if (failure.times !== undefined) {
      failure.times -= 1;
      if (failure.times === 0) {
        failure = null;
      }
    }
    return stderr;
  }

  return {
    platform: options.platform ?? "linux",
    uid: 1000,
    env: {},
    commands,
    calls,
    priorities,
    processes,
    files,
    failCommands(next) {
      failure = next ? { ...next } : null;
    },
    async findExecutable(name) {
      if (name === "nice") {
        return options.nice === false ? null : "/usr/bin/nice";
      }
      return systemd ? `/usr/bin/${name}` : null;
    },
    async exec(call) {
      const { command, args } = call;
      if (command.endsWith("/nice")) {
        return runNice(command, args);
      }
      calls.push(call);
      commands.push([command, ...args]);
      const stderr = shouldFail(args);
      if (stderr !== null) {
        throw new ResourceHostCommandError(command, stderr);
      }
      if (args.includes("get-property")) {
        return args.at(-1) === "Version" ? 's "257.9-1.fc45"\n' : `s "${MANAGER_CGROUP}"\n`;
      }
      if (args.includes("--property=ActiveState")) {
        return `${activationStates.shift() ?? "active"}\n`;
      }
      if (args.includes("show")) {
        const cgroup = cgroupFor(args[2]);
        if (options.effectiveCpus !== undefined) {
          files.set(`/sys/fs/cgroup${cgroup}/cpuset.cpus.effective`, options.effectiveCpus);
        }
        return `${cgroup}\n`;
      }
      return "";
    },
    async readFile(path) {
      const stat = /^\/proc\/(\d+)\/stat$/.exec(path);
      if (stat && processes.has(Number(stat[1]))) {
        return `${stat[1]} (provider) S 1 ${stat[1]} ${stat[1]} 0 -1`;
      }
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return content;
    },
    async listDirectories(path) {
      if (path === "/proc") {
        return [...processes].map(String);
      }
      const task = /^\/proc\/(\d+)\/task$/.exec(path);
      return task && processes.has(Number(task[1])) ? [task[1]] : [];
    },
    setPriority(tid, nice) {
      if (options.setPriorityError) {
        throw systemError(options.setPriorityError);
      }
      // The kernel lets anyone lower a priority and only the privileged raise one.
      if (nice < (priorities.get(tid) ?? 0) && !options.mayRaisePriority) {
        throw systemError("EACCES");
      }
      priorities.set(tid, nice);
    },
    getPriority(tid) {
      return priorities.get(tid) ?? 0;
    },
    async sleep() {},
  };
}

export function fakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), { pid }) as unknown as ChildProcess;
}
