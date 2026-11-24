import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCachedCliPathResolver,
  createForgeCliRunner,
  probeHostViaCliAuthStatus,
} from "./forge-cli-command.js";
import { isPlatform } from "../test-utils/platform.js";

describe.skipIf(isPlatform("win32"))("probeHostViaCliAuthStatus", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "forge-cli-command-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFakeCli(script: string): string {
    const cliPath = join(tempDir, "forge-cli");
    writeFileSync(cliPath, script);
    chmodSync(cliPath, 0o755);
    return cliPath;
  }

  it("recognizes a host when the CLI auth status succeeds", async () => {
    const cli = writeFakeCli(`#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--hostname" ] && [ "$4" = "git.acme.internal" ]; then
  exit 0
fi
exit 1
`);

    await expect(
      probeHostViaCliAuthStatus({
        cli,
        host: "git.acme.internal",
      }),
    ).resolves.toBe(true);
  });

  it("rejects a host when the CLI auth status fails", async () => {
    const cli = writeFakeCli(`#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
exit 1
`);

    await expect(
      probeHostViaCliAuthStatus({
        cli,
        host: "git.acme.internal",
      }),
    ).resolves.toBe(false);
  });

  it("rejects a host when the CLI is missing", async () => {
    await expect(
      probeHostViaCliAuthStatus({
        cli: join(tempDir, "missing-cli"),
        host: "git.acme.internal",
      }),
    ).resolves.toBe(false);
  });

  it("invokes the resolved executable path instead of re-searching PATH by bare name", async () => {
    const originalPath = process.env.PATH;
    const earlierDir = join(tempDir, "earlier-bin");
    const workingDir = join(tempDir, "working-bin");
    mkdirSync(earlierDir);
    mkdirSync(workingDir);

    const shadowingCli = join(earlierDir, "forge-probe-cli");
    const workingCli = join(workingDir, "forge-probe-cli");
    writeFileSync(
      workingCli,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '#!/bin/sh\\nexit 1\\n' > "${shadowingCli}"
  chmod 755 "${shadowingCli}"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--hostname" ] && [ "$4" = "git.acme.internal" ]; then
  exit 0
fi
exit 1
`,
    );
    chmodSync(workingCli, 0o755);

    process.env.PATH = [earlierDir, workingDir, originalPath].filter(Boolean).join(delimiter);
    try {
      await expect(
        probeHostViaCliAuthStatus({
          cli: "forge-probe-cli",
          host: "git.acme.internal",
        }),
      ).resolves.toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe.skipIf(isPlatform("win32"))("createForgeCliRunner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "forge-cli-runner-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSlowCli(): string {
    const cliPath = join(tempDir, "slow-cli");
    writeFileSync(cliPath, "#!/bin/sh\nsleep 5\n");
    chmodSync(cliPath, 0o755);
    return cliPath;
  }

  class FakeCommandError extends Error {
    readonly stderr: string;
    constructor(params: { stderr: string }) {
      super("command failed");
      this.stderr = params.stderr;
    }
  }

  it("kills a hung CLI invocation after the configured timeout", async () => {
    const cli = writeSlowCli();
    const runner = createForgeCliRunner({
      binary: cli,
      envOverlay: {},
      timeoutMs: 100,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    await expect(runner.run(["arg"], { cwd: tempDir })).rejects.toThrow();
  });

  it("classifies a timed-out invocation through normalizeError", async () => {
    const cli = writeSlowCli();
    const runner = createForgeCliRunner({
      binary: cli,
      envOverlay: {},
      timeoutMs: 100,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    const rawError = await runner.run(["arg"], { cwd: tempDir }).catch((error: unknown) => error);
    const normalized = runner.normalizeError(rawError, { args: ["arg"], cwd: tempDir });
    expect(normalized).toBeInstanceOf(FakeCommandError);
    expect((normalized as FakeCommandError).stderr).toMatch(/timed out after 100ms/);
  });

  it("executes the provided executablePath instead of re-resolving binary from PATH", async () => {
    const originalPath = process.env.PATH;
    const pathDir = join(tempDir, "path-bin");
    const resolvedDir = join(tempDir, "resolved-bin");
    mkdirSync(pathDir);
    mkdirSync(resolvedDir);

    const pathCli = join(pathDir, "forge-cli-test");
    writeFileSync(pathCli, "#!/bin/sh\necho from-path\n");
    chmodSync(pathCli, 0o755);

    const resolvedCli = join(resolvedDir, "forge-cli-test");
    writeFileSync(resolvedCli, "#!/bin/sh\necho from-resolved\n");
    chmodSync(resolvedCli, 0o755);

    const runner = createForgeCliRunner({
      binary: "forge-cli-test",
      envOverlay: {},
      timeoutMs: 2_000,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    process.env.PATH = [pathDir, originalPath].filter(Boolean).join(delimiter);
    try {
      const result = await runner.run(["status"], {
        cwd: tempDir,
        executablePath: resolvedCli,
      });
      expect(result.stdout.trim()).toBe("from-resolved");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resolves a bare binary via resolveExecutablePath when executablePath is omitted", async () => {
    const originalPath = process.env.PATH;
    const pathDir = join(tempDir, "path-bin");
    const resolvedDir = join(tempDir, "resolved-bin");
    mkdirSync(pathDir);
    mkdirSync(resolvedDir);

    const pathCli = join(pathDir, "forge-cli-default");
    writeFileSync(pathCli, "#!/bin/sh\necho from-path\n");
    chmodSync(pathCli, 0o755);

    const resolvedCli = join(resolvedDir, "forge-cli-default");
    writeFileSync(resolvedCli, "#!/bin/sh\necho from-resolver\n");
    chmodSync(resolvedCli, 0o755);

    const runner = createForgeCliRunner({
      binary: "forge-cli-default",
      envOverlay: {},
      timeoutMs: 2_000,
      isAuthFailureText: () => false,
      resolveExecutablePath: async () => resolvedCli,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    process.env.PATH = [pathDir, originalPath].filter(Boolean).join(delimiter);
    try {
      const result = await runner.run(["status"], { cwd: tempDir });
      expect(result.stdout.trim()).toBe("from-resolver");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("throws createMissingError when a bare binary cannot be resolved", async () => {
    const runner = createForgeCliRunner({
      binary: "forge-cli-uninstalled",
      envOverlay: {},
      timeoutMs: 2_000,
      isAuthFailureText: () => false,
      resolveExecutablePath: async () => null,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("forge-cli-missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    await expect(runner.run(["status"], { cwd: tempDir })).rejects.toThrow("forge-cli-missing");
  });

  it("re-resolves and retries once when the cached executable is removed from PATH", async () => {
    const originalPath = process.env.PATH;
    const firstDir = join(tempDir, "first-bin");
    const secondDir = join(tempDir, "second-bin");
    mkdirSync(firstDir);
    mkdirSync(secondDir);

    const firstCli = join(firstDir, "forge-cli-fallback");
    writeFileSync(firstCli, "#!/bin/sh\necho from-first\n");
    chmodSync(firstCli, 0o755);

    const secondCli = join(secondDir, "forge-cli-fallback");
    writeFileSync(secondCli, "#!/bin/sh\necho from-second\n");
    chmodSync(secondCli, 0o755);

    const runner = createForgeCliRunner({
      binary: "forge-cli-fallback",
      envOverlay: {},
      timeoutMs: 2_000,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    process.env.PATH = [firstDir, secondDir, originalPath].filter(Boolean).join(delimiter);
    try {
      await expect(runner.run(["status"], { cwd: tempDir })).resolves.toMatchObject({
        stdout: "from-first\n",
      });
      rmSync(firstCli);
      await expect(runner.run(["status"], { cwd: tempDir })).resolves.toMatchObject({
        stdout: "from-second\n",
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("re-resolves and retries once when the cached executable loses execute permission", async () => {
    const originalPath = process.env.PATH;
    const firstDir = join(tempDir, "first-perm-bin");
    const secondDir = join(tempDir, "second-perm-bin");
    mkdirSync(firstDir);
    mkdirSync(secondDir);

    const firstCli = join(firstDir, "forge-cli-perm");
    writeFileSync(firstCli, "#!/bin/sh\necho from-first\n");
    chmodSync(firstCli, 0o755);

    const secondCli = join(secondDir, "forge-cli-perm");
    writeFileSync(secondCli, "#!/bin/sh\necho from-second\n");
    chmodSync(secondCli, 0o755);

    const runner = createForgeCliRunner({
      binary: "forge-cli-perm",
      envOverlay: {},
      timeoutMs: 2_000,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    process.env.PATH = [firstDir, secondDir, originalPath].filter(Boolean).join(delimiter);
    try {
      await expect(runner.run(["status"], { cwd: tempDir })).resolves.toMatchObject({
        stdout: "from-first\n",
      });
      chmodSync(firstCli, 0o644);
      await expect(runner.run(["status"], { cwd: tempDir })).resolves.toMatchObject({
        stdout: "from-second\n",
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe.runIf(isPlatform("win32"))("createForgeCliRunner (Windows)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "forge-cli-win-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  class FakeCommandError extends Error {
    readonly stderr: string;
    constructor(params: { stderr: string }) {
      super("command failed");
      this.stderr = params.stderr;
    }
  }

  it("runs the resolved executable instead of a cwd-local script and preserves percent-delimited args", async () => {
    const originalPath = process.env.PATH;
    const originalVar = process.env.PASEO_FORGE_ARG_LITERAL;
    const binDir = join(tempDir, "bin");
    const repoDir = join(tempDir, "repo");
    mkdirSync(binDir);
    mkdirSync(repoDir);

    const installedExe = join(binDir, "forge-win-cli.exe");
    copyFileSync(process.execPath, installedExe);
    writeFileSync(join(repoDir, "forge-win-cli.cmd"), "@echo off\r\necho from-cwd\r\n");

    const runner = createForgeCliRunner({
      binary: "forge-win-cli",
      envOverlay: {},
      timeoutMs: 5_000,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter);
    process.env.PASEO_FORGE_ARG_LITERAL = "expanded-env-value";
    try {
      const result = await runner.run(
        [
          "-e",
          "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
          "--",
          "%PASEO_FORGE_ARG_LITERAL%",
          "query=query Test {\n  viewer { login }\n}",
        ],
        { cwd: repoDir },
      );
      expect(JSON.parse(result.stdout)).toEqual([
        "%PASEO_FORGE_ARG_LITERAL%",
        "query=query Test {\n  viewer { login }\n}",
      ]);
    } finally {
      process.env.PATH = originalPath;
      if (originalVar === undefined) {
        delete process.env.PASEO_FORGE_ARG_LITERAL;
      } else {
        process.env.PASEO_FORGE_ARG_LITERAL = originalVar;
      }
    }
  });
});

describe("createCachedCliPathResolver", () => {
  it("resolves once and reuses the cached path on later calls", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return "/usr/bin/forge-cli";
    });

    await expect(resolveCliPath()).resolves.toBe("/usr/bin/forge-cli");
    await expect(resolveCliPath()).resolves.toBe("/usr/bin/forge-cli");
    expect(calls).toBe(1);
  });

  it("retries on the next call after a miss instead of caching null forever", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return calls === 1 ? null : "/usr/bin/forge-cli";
    });

    await expect(resolveCliPath()).resolves.toBeNull();
    await expect(resolveCliPath()).resolves.toBe("/usr/bin/forge-cli");
    expect(calls).toBe(2);
  });

  it("coalesces concurrent callers onto a single in-flight resolution", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return "/usr/bin/forge-cli";
    });

    await Promise.all([resolveCliPath(), resolveCliPath(), resolveCliPath()]);
    expect(calls).toBe(1);
  });

  it("re-resolves after invalidate matches the cached path and ignores mismatched paths", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return calls === 1 ? "/first/bin/forge-cli" : "/second/bin/forge-cli";
    });

    await expect(resolveCliPath()).resolves.toBe("/first/bin/forge-cli");
    resolveCliPath.invalidate("/other/bin/forge-cli");
    await expect(resolveCliPath()).resolves.toBe("/first/bin/forge-cli");
    expect(calls).toBe(1);

    resolveCliPath.invalidate("/first/bin/forge-cli");
    await expect(resolveCliPath()).resolves.toBe("/second/bin/forge-cli");
    expect(calls).toBe(2);
  });
});
