import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  compileWindowsCliStub,
  compileWindowsCliProbe,
} = require("../../scripts/windows-cli-stub.js");

function sameFile(left: string, right: string): boolean {
  const a = statSync(left);
  const b = statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

function decodeArg(line: string): string {
  return Buffer.from(line.slice("ARG".length).replace(/^\d+=/, ""), "base64").toString("utf8");
}

interface ProbeReport {
  env: Record<string, string>;
  args: string[];
}

function readProbe(outPath: string): ProbeReport {
  const lines = readFileSync(outPath, "utf8")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const env: Record<string, string> = {};
  const args: string[] = [];
  for (const line of lines) {
    if (line.startsWith("ARG")) {
      args.push(decodeArg(line));
      continue;
    }
    const separator = line.indexOf("=");
    env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return { env, args };
}

function invokeWithPowerShell(stubPath: string, powerShellArgument: string, outPath: string) {
  const scriptPath = join(dirname(outPath), "invoke.ps1");
  const quotedStub = `'${stubPath.replace(/'/g, "''")}'`;
  writeFileSync(
    scriptPath,
    [
      "$PSNativeCommandArgumentPassing = 'Windows'",
      `& ${quotedStub} ${powerShellArgument}`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"),
    "utf8",
  );
  return spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
    encoding: "utf8",
    env: { ...process.env, PASEO_PROBE_OUT: outPath },
  });
}

describe("Windows packaged CLI stub", () => {
  it.skipIf(process.platform !== "win32")(
    "keeps quotes and newlines that PowerShell strips from paseo.cmd",
    () => {
      const root = mkdtempSync(join(tmpdir(), "paseo cli stub-"));
      try {
        const stubPath = join(root, "resources", "bin", "paseo.exe");
        const appPath = join(root, "Paseo.exe");
        mkdirSync(dirname(stubPath), { recursive: true });
        compileWindowsCliProbe(appPath);
        compileWindowsCliStub(stubPath);

        const quoted = join(root, "quoted.txt");
        const quotedRun = invokeWithPowerShell(stubPath, `'{"k":"v"}'`, quoted);
        expect(quotedRun.status, quotedRun.stderr).toBe(0);
        const quotedProbe = readProbe(quoted);
        expect(quotedProbe.args.at(-1)).toBe('{"k":"v"}');
        expect(quotedProbe.args).toContain("--disable-warning=DEP0040");
        expect(quotedProbe.args).toContain("node-script");
        expect(quotedProbe.args.some((arg) => arg.endsWith("node-entrypoint-runner.js"))).toBe(
          true,
        );
        expect(
          quotedProbe.args.some((arg) =>
            arg.endsWith(join("@getpaseo", "cli", "dist", "index.js")),
          ),
        ).toBe(true);
        expect(quotedProbe.env.ELECTRON_RUN_AS_NODE).toBe("1");
        expect(quotedProbe.env.PASEO_NODE_ENV).toBe("production");
        expect(sameFile(quotedProbe.env.PASEO_CLI, stubPath)).toBe(true);

        const multiline = join(root, "multiline.txt");
        const multilineRun = invokeWithPowerShell(stubPath, '"line1`r`nline2 status"', multiline);
        expect(multilineRun.status, multilineRun.stderr).toBe(0);
        expect(readProbe(multiline).args.at(-1)).toBe("line1\r\nline2 status");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "forwards PATH launcher arguments to the bundled stub",
    () => {
      const root = mkdtempSync(join(tmpdir(), "paseo cli forward-"));
      try {
        const stubPath = join(root, "resources", "bin", "paseo.exe");
        const forwarderPath = join(root, "local", "bin", "paseo.exe");
        mkdirSync(dirname(stubPath), { recursive: true });
        mkdirSync(dirname(forwarderPath), { recursive: true });
        compileWindowsCliProbe(join(root, "Paseo.exe"));
        compileWindowsCliStub(stubPath);
        compileWindowsCliStub(forwarderPath);
        writeFileSync(join(dirname(forwarderPath), "paseo.target"), `${stubPath}\r\n`, "utf8");

        const outPath = join(root, "forward.txt");
        const run = invokeWithPowerShell(forwarderPath, `'{"k":"v"}'`, outPath);

        expect(run.status, run.stderr).toBe(0);
        const probe = readProbe(outPath);
        expect(probe.args.at(-1)).toBe('{"k":"v"}');
        expect(sameFile(probe.env.PASEO_CLI, stubPath)).toBe(true);
        expect(sameFile(probe.env.PASEO_CLI, forwarderPath)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")("reports a missing bundled executable", () => {
    const root = mkdtempSync(join(tmpdir(), "paseo cli missing-"));
    try {
      const stubPath = join(root, "resources", "bin", "paseo.exe");
      mkdirSync(dirname(stubPath), { recursive: true });
      compileWindowsCliStub(stubPath);

      const run = invokeWithPowerShell(stubPath, "'--version'", join(root, "missing.txt"));

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Bundled Paseo executable not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "passes redirected standard handles to a GUI-subsystem child",
    () => {
      const root = mkdtempSync(join(tmpdir(), "paseo cli stdio-"));
      try {
        const stubPath = join(root, "resources", "bin", "paseo.exe");
        const appPath = join(root, "Paseo.exe");
        const outPath = join(root, "stdio.txt");
        mkdirSync(dirname(stubPath), { recursive: true });
        compileWindowsCliProbe(appPath, "windows");
        compileWindowsCliStub(stubPath);

        const run = spawnSync(stubPath, ["--version"], {
          encoding: "utf8",
          input: "stdin-marker",
          env: { ...process.env, PASEO_PROBE_OUT: outPath, PASEO_PROBE_STDIO: "1" },
        });

        expect(run.status, run.stderr).toBe(7);
        expect(run.stdout).toContain("stdout-marker");
        expect(run.stdout).toContain("stdin-marker");
        expect(run.stderr).toContain("stderr-marker");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")("stops when the forward target points at itself", () => {
    const root = mkdtempSync(join(tmpdir(), "paseo cli self-"));
    try {
      const stubPath = join(root, "paseo.exe");
      mkdirSync(root, { recursive: true });
      compileWindowsCliStub(stubPath);
      writeFileSync(join(root, "paseo.target"), `${stubPath}\r\n`, "utf8");

      const run = invokeWithPowerShell(stubPath, "'--version'", join(root, "self.txt"));

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Paseo CLI target points at itself");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
