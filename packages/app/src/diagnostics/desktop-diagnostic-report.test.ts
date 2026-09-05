import { describe, expect, test } from "vitest";
import {
  collectDesktopDiagnosticSections,
  type DesktopDiagnosticSources,
} from "./desktop-diagnostic-report";

function makeSources(): DesktopDiagnosticSources {
  return {
    getStatus: async () => ({
      serverId: "server-1",
      status: "running",
      listen: "127.0.0.1:6767",
      hostname: "host",
      pid: 4242,
      home: "/paseo/home",
      version: "1.2.3",
      desktopManaged: true,
      error: null,
    }),
    getDaemonLogs: async () => ({
      logPath: "/paseo/home/daemon.log",
      contents: "daemon line one\ndaemon line two",
    }),
    getAppLogs: async () => ({
      logPath: "/logs/Paseo/main.log",
      contents: "[login-shell-env] start\n[login-shell-env] failed",
    }),
    getUpdaterDiagnostics: async () => ({
      platform: "darwin",
      currentVersion: "0.7.0",
      targetVersion: "0.7.2",
      targetVersionError: null,
      shipItDirectory: "/cache/sh.paseo.desktop.ShipIt",
      state: {
        path: "/cache/sh.paseo.desktop.ShipIt/ShipItState.plist",
        exists: true,
        modifiedAt: "2026-09-04T11:22:19.000Z",
        contents: '{"launchAfterInstallation":true}',
        error: null,
      },
      stdout: {
        path: "/cache/sh.paseo.desktop.ShipIt/ShipIt_stdout.log",
        exists: false,
        modifiedAt: null,
        contents: "",
        error: null,
      },
      stderr: {
        path: "/cache/sh.paseo.desktop.ShipIt/ShipIt_stderr.log",
        exists: true,
        modifiedAt: "2026-09-01T08:39:20.000Z",
        contents: "Installation completed successfully",
        error: null,
      },
    }),
  };
}

describe("desktop diagnostic report", () => {
  test("starts desktop diagnostic requests together", async () => {
    const calls: string[] = [];
    let releaseAppLogs: () => void = () => {};
    const appLogGate = new Promise<void>((resolve) => {
      releaseAppLogs = resolve;
    });
    const sources: DesktopDiagnosticSources = {
      ...makeSources(),
      getStatus: async () => {
        calls.push("status");
        return makeSources().getStatus();
      },
      getDaemonLogs: async () => {
        calls.push("daemonLogs");
        return makeSources().getDaemonLogs();
      },
      getAppLogs: async () => {
        calls.push("appLogs");
        await appLogGate;
        return makeSources().getAppLogs();
      },
      getUpdaterDiagnostics: async () => {
        calls.push("updater");
        return makeSources().getUpdaterDiagnostics();
      },
    };

    const resultPromise = collectDesktopDiagnosticSections(sources);

    expect(calls).toEqual(["status", "daemonLogs", "appLogs", "updater"]);
    releaseAppLogs();
    await expect(resultPromise).resolves.toMatchObject({ status: "done" });
  });

  test("includes target version lookup errors", async () => {
    const sources: DesktopDiagnosticSources = {
      ...makeSources(),
      getUpdaterDiagnostics: async () => ({
        ...(await makeSources().getUpdaterDiagnostics()),
        targetVersion: null,
        targetVersionError: "plutil failed",
      }),
    };

    const result = await collectDesktopDiagnosticSections(sources);
    expect(result.sections.join("\n\n")).toContain("Target version error: plutil failed");
  });

  test("includes the Electron main-process log after the daemon log", async () => {
    const result = await collectDesktopDiagnosticSections(makeSources());
    const report = result.sections.join("\n\n");

    expect(result.status).toBe("done");
    expect(report).toContain("  Log path: /paseo/home/daemon.log");
    expect(report).toContain("  App log path: /logs/Paseo/main.log");
    expect(report).toContain("Desktop daemon log tail\n  daemon line one\n  daemon line two");
    expect(report).toContain(
      "Desktop app log tail\n  [login-shell-env] start\n  [login-shell-env] failed",
    );
    expect(report.indexOf("Desktop app log tail")).toBeGreaterThan(
      report.indexOf("Desktop daemon log tail"),
    );
    expect(report).toContain("Desktop updater\n  Platform: darwin");
    expect(report).toContain("  Current version: 0.7.0");
    expect(report).toContain("  Target version: 0.7.2");
    expect(report).toContain("ShipItState.plist");
    expect(report).toContain('{"launchAfterInstallation":true}');
    expect(report).toContain("ShipIt stdout log tail");
    expect(report).toContain("  File not found");
    expect(report).toContain("Installation completed successfully");
  });

  test("keeps daemon diagnostics when the Electron app log fails", async () => {
    const sources = {
      ...makeSources(),
      getAppLogs: async () => {
        throw new Error("app log unavailable");
      },
    };

    const result = await collectDesktopDiagnosticSections(sources);
    const report = result.sections.join("\n\n");

    expect(result.status).toBe("failed");
    expect(report).toContain("Desktop daemon log tail\n  daemon line one\n  daemon line two");
    expect(report).toContain("Desktop app log tail\n  Error: app log unavailable");
  });
});
