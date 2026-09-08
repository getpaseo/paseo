import { describe, expect, it, vi } from "vitest";
import {
  inheritLoginShellEnvForService,
  isDaemonOnlyLaunch,
  resolveDaemonOnlyExitCode,
  runDaemonOnly,
  type DaemonOnlyChildProcess,
} from "./daemon-only";

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

class FakeDaemonProcess implements DaemonOnlyChildProcess {
  readonly signalsReceived: NodeJS.Signals[] = [];
  private exitListener: ExitListener | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  once(event: "exit", listener: ExitListener): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit" | "error", listener: ExitListener | ((error: Error) => void)): this {
    if (event === "exit") {
      this.exitListener = listener as ExitListener;
    } else {
      this.errorListener = listener as (error: Error) => void;
    }
    return this;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signalsReceived.push(signal);
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitListener?.(code, signal);
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
  }
}

class StopTrigger {
  private requestStop: (() => void) | null = null;

  register = (requestStop: () => void): void => {
    this.requestStop = requestStop;
  };

  fire(): void {
    if (!this.requestStop) {
      throw new Error("No stop handler was registered");
    }
    this.requestStop();
  }
}

describe("daemon-only launch detection", () => {
  it("detects the flag in a packaged launch", () => {
    expect(
      isDaemonOnlyLaunch({
        argv: ["/opt/Paseo/paseo", "--no-sandbox", "--daemon-only"],
        isDefaultApp: false,
      }),
    ).toBe(true);
  });

  it("detects the flag in a dev launch that passes the app directory", () => {
    expect(
      isDaemonOnlyLaunch({
        argv: ["/usr/bin/electron", "/repo/packages/desktop", "--daemon-only"],
        isDefaultApp: true,
      }),
    ).toBe(true);
  });

  it("does not treat the executable path as a flag", () => {
    expect(isDaemonOnlyLaunch({ argv: ["/opt/--daemon-only/paseo"], isDefaultApp: false })).toBe(
      false,
    );
  });

  it("is false for a plain GUI launch", () => {
    expect(isDaemonOnlyLaunch({ argv: ["/opt/Paseo/paseo"], isDefaultApp: false })).toBe(false);
  });

  it("is false for a passthrough CLI launch", () => {
    expect(
      isDaemonOnlyLaunch({ argv: ["/opt/Paseo/paseo", "daemon", "status"], isDefaultApp: false }),
    ).toBe(false);
  });
});

describe("daemon-only exit code", () => {
  it("uses the daemon's own exit code", () => {
    expect(resolveDaemonOnlyExitCode({ code: 3, signal: null, requestedStopSignal: null })).toBe(3);
  });

  it("reports success when the daemon died from the signal we forwarded", () => {
    expect(
      resolveDaemonOnlyExitCode({ code: null, signal: "SIGTERM", requestedStopSignal: "SIGTERM" }),
    ).toBe(0);
  });

  it("reports failure when the daemon died from a signal we did not send", () => {
    expect(
      resolveDaemonOnlyExitCode({ code: null, signal: "SIGKILL", requestedStopSignal: "SIGTERM" }),
    ).toBe(1);
  });

  it("reports failure when the daemon died from a signal and no stop was requested", () => {
    expect(
      resolveDaemonOnlyExitCode({ code: null, signal: "SIGSEGV", requestedStopSignal: null }),
    ).toBe(1);
  });
});

describe("runDaemonOnly", () => {
  it("stops the daemon when Electron asks to quit and exits 0 once it is down", async () => {
    const child = new FakeDaemonProcess();
    const stopTrigger = new StopTrigger();

    const exitCode = runDaemonOnly({
      spawnDaemon: () => child,
      onStopRequested: stopTrigger.register,
      onSpawnError: vi.fn(),
    });

    stopTrigger.fire();
    expect(child.signalsReceived).toEqual(["SIGTERM"]);

    child.emitExit(null, "SIGTERM");
    await expect(exitCode).resolves.toBe(0);
  });

  it("escalates to SIGKILL when a second stop arrives", async () => {
    const child = new FakeDaemonProcess();
    const stopTrigger = new StopTrigger();

    const exitCode = runDaemonOnly({
      spawnDaemon: () => child,
      onStopRequested: stopTrigger.register,
      onSpawnError: vi.fn(),
    });

    stopTrigger.fire();
    stopTrigger.fire();
    stopTrigger.fire();
    expect(child.signalsReceived).toEqual(["SIGTERM", "SIGKILL"]);

    child.emitExit(null, "SIGKILL");
    await expect(exitCode).resolves.toBe(0);
  });

  it("propagates a daemon crash exit code so a service supervisor can restart it", async () => {
    const child = new FakeDaemonProcess();

    const exitCode = runDaemonOnly({
      spawnDaemon: () => child,
      onStopRequested: new StopTrigger().register,
      onSpawnError: vi.fn(),
    });

    child.emitExit(1, null);
    await expect(exitCode).resolves.toBe(1);
  });

  it("reports a crash signal as a failure when no stop was requested", async () => {
    const child = new FakeDaemonProcess();

    const exitCode = runDaemonOnly({
      spawnDaemon: () => child,
      onStopRequested: new StopTrigger().register,
      onSpawnError: vi.fn(),
    });

    child.emitExit(null, "SIGSEGV");
    await expect(exitCode).resolves.toBe(1);
  });

  it("reports a spawn failure and exits non-zero", async () => {
    const child = new FakeDaemonProcess();
    const onSpawnError = vi.fn();
    const error = new Error("ENOENT");

    const exitCode = runDaemonOnly({
      spawnDaemon: () => child,
      onStopRequested: new StopTrigger().register,
      onSpawnError,
    });

    child.emitError(error);
    await expect(exitCode).resolves.toBe(1);
    expect(onSpawnError).toHaveBeenCalledWith(error);
  });
});

describe("service environment precedence", () => {
  it("keeps the unit's Paseo configuration when the login shell exports its own", () => {
    const env: NodeJS.ProcessEnv = {
      PASEO_HOME: "/srv/paseo-home",
      PASEO_LISTEN: "127.0.0.1:6767",
      PATH: "/usr/bin",
    };

    inheritLoginShellEnvForService({
      env,
      inheritLoginShellEnv: () => {
        Object.assign(env, {
          PASEO_HOME: "/home/dev/.paseo",
          PASEO_LISTEN: "127.0.0.1:9999",
          PATH: "/home/dev/.local/bin:/usr/bin",
        });
      },
    });

    expect(env.PASEO_HOME).toBe("/srv/paseo-home");
    expect(env.PASEO_LISTEN).toBe("127.0.0.1:6767");
  });

  it("still takes the login shell PATH the agents need", () => {
    const env: NodeJS.ProcessEnv = { PASEO_HOME: "/srv/paseo-home", PATH: "/usr/bin" };

    inheritLoginShellEnvForService({
      env,
      inheritLoginShellEnv: () => {
        env.PATH = "/home/dev/.local/bin:/usr/bin";
        env.NVM_DIR = "/home/dev/.nvm";
      },
    });

    expect(env.PATH).toBe("/home/dev/.local/bin:/usr/bin");
    expect(env.NVM_DIR).toBe("/home/dev/.nvm");
  });

  it("takes a Paseo variable from the login shell when the unit did not set it", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    inheritLoginShellEnvForService({
      env,
      inheritLoginShellEnv: () => {
        env.PASEO_HOME = "/home/dev/.paseo";
      },
    });

    expect(env.PASEO_HOME).toBe("/home/dev/.paseo");
  });
});
