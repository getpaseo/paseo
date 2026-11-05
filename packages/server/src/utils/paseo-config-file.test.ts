import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeFile, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { isPlatform } from "../test-utils/platform.js";
import {
  readPaseoConfig,
  PaseoConfigSchema,
  PaseoConfigRawSchema,
  getWorktreeSetupCommands,
  getWorktreeTeardownCommands,
} from "./worktree.js";
import {
  readPaseoConfigForEdit,
  statPaseoConfigPath,
  writePaseoConfigForEdit,
} from "./paseo-config-file.js";

let probeDirectory: string;
let probePath: string;

beforeAll(async () => {
  probeDirectory = mkdtempSync(join(tmpdir(), "paseo-config-probe-"));
  probePath = join(probeDirectory, "config-responsiveness.mjs");
  // Compile before starting the measured process. A runtime TypeScript loader
  // owns MessagePorts that the responsiveness probe otherwise charges as work.
  await build({
    entryPoints: [
      fileURLToPath(new URL("./test-fixtures/config-responsiveness.ts", import.meta.url)),
    ],
    outfile: probePath,
    bundle: true,
    platform: "node",
    format: "esm",
  });
});

afterAll(() => {
  rmSync(probeDirectory, { recursive: true, force: true });
});

async function measureConfigRead(directory: string) {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [probePath, directory], {
    timeout: 15_000,
  });
  process.stderr.write(stderr);
  return JSON.parse(stdout) as {
    result: Awaited<ReturnType<typeof readPaseoConfigForEdit>>;
    blockingMs: number;
    filesystemRequests: number;
    yields: number;
    workerMessages: number;
  };
}

describe("paseo config file substrate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "paseo-config-file-test-")));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects an oversized config before parsing its otherwise valid JSON", async () => {
    writeFileSync(
      join(tempDir, "paseo.json"),
      JSON.stringify({ extra: "x".repeat(2 * 1024 * 1024) }),
    );
    expect(await readPaseoConfigForEdit(tempDir)).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
  });

  it("rejects a sparse oversized file without allocating its contents", async () => {
    const configPath = join(tempDir, "paseo.json");
    await writeFile(configPath, "");
    await truncate(configPath, 1024 * 1024 * 1024);
    expect(await readPaseoConfigForEdit(tempDir)).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
  });

  it.skipIf(isPlatform("win32"))("rejects a FIFO without waiting for a writer", async () => {
    await promisify(execFile)("mkfifo", [join(tempDir, "paseo.json")]);
    const modulePath = fileURLToPath(new URL("./paseo-config-file.ts", import.meta.url));
    const script = `import { readPaseoConfigForEdit } from ${JSON.stringify(modulePath)};
      const result = await readPaseoConfigForEdit(${JSON.stringify(tempDir)});
      if (JSON.stringify(result) !== JSON.stringify({ok:false,error:{code:"invalid_project_config"}})) process.exit(1);`;
    // Isolate the regression: the old sync reader blocks on the pipe and must be killed.
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { timeout: 2_000 },
    );
  });

  it("excludes test-runner and loader activity from the config read budget", async () => {
    await writeFile(join(tempDir, "paseo.json"), JSON.stringify({ worktree: { setup: "npm ci" } }));
    const unrelatedWork = new Promise<void>((resolve) => {
      setImmediate(() => {
        const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage = Reflect.get(
          process,
          "threadCpuUsage",
        );
        const start = threadCpuUsage();
        let elapsed: NodeJS.CpuUsage;
        do {
          elapsed = threadCpuUsage(start);
        } while (elapsed.user + elapsed.system < 60_000);
        resolve();
      });
    });
    const { result, blockingMs, filesystemRequests, workerMessages } =
      await measureConfigRead(tempDir);
    await unrelatedWork;
    expect(workerMessages).toBe(0);
    expect(result).toEqual({
      ok: true,
      config: { worktree: { setup: "npm ci" } },
      revision: await statPaseoConfigPath(tempDir),
    });
    expect(filesystemRequests).toBeGreaterThan(0);
    expect(blockingMs).toBeLessThan(20);
  });

  it("keeps main-thread work below 20ms while admitting large configs", async () => {
    const config = {
      scripts: Object.fromEntries(
        Array.from({ length: 7_000 }, (_, i) => [`script${i}`, { command: "echo hi" }]),
      ),
      worktree: { setup: "npm ci" },
    };
    await writeFile(join(tempDir, "paseo.json"), JSON.stringify(config));
    const { result, blockingMs, filesystemRequests, yields, workerMessages } =
      await measureConfigRead(tempDir);
    expect(result).toEqual({ ok: true, config, revision: await statPaseoConfigPath(tempDir) });
    expect(blockingMs).toBeLessThan(20);
    expect(filesystemRequests).toBeGreaterThan(0);
    expect(yields).toBeGreaterThan(0);
    expect(workerMessages).toBe(0);
  });

  it("rejects a 32MiB config with main-thread work below 20ms", async () => {
    await writeFile(
      join(tempDir, "paseo.json"),
      JSON.stringify({ extra: "x".repeat(32 * 1024 * 1024) }),
    );
    const { result, blockingMs, filesystemRequests, workerMessages } =
      await measureConfigRead(tempDir);
    expect(blockingMs).toBeLessThan(20);
    expect(filesystemRequests).toBeGreaterThan(0);
    expect(workerMessages).toBe(0);
    expect(result).toEqual({ ok: false, error: { code: "invalid_project_config" } });
  });

  it.each([
    {
      scripts: Object.fromEntries(
        Array.from({ length: 130 }, (_, i) => [
          `script${i}`,
          { command: "echo hi", extra: { keep: true } },
        ]),
      ),
    },
    {
      scripts: { valid: { command: "echo hi" }, invalid: 42 },
      worktree: { setup: ["one", "", 42] },
    },
    { scripts: ["invalid record"], worktree: { setup: "echo hi" } },
    JSON.parse(
      '{"scripts":{"__proto__":{"command":"echo hi"},"constructor":{"command":"echo hi"}}}',
    ),
  ])("preserves edit and runtime schema behavior with grouped validation (%#)", async (config) => {
    await writeFile(join(tempDir, "paseo.json"), JSON.stringify(config));
    const expected = PaseoConfigRawSchema.safeParse(config);
    expect(await readPaseoConfigForEdit(tempDir)).toEqual(
      expected.success
        ? { ok: true, config: expected.data, revision: await statPaseoConfigPath(tempDir) }
        : { ok: false, error: { code: "invalid_project_config" } },
    );
    expect(await readPaseoConfig(tempDir)).toEqual({
      ok: true,
      config: PaseoConfigSchema.parse(config),
    });
  });

  it("refreshes snapshots after an external edit, repair, and removal", async () => {
    const configPath = join(tempDir, "paseo.json");
    await writeFile(configPath, JSON.stringify({ worktree: { setup: "old" } }));
    const original = await readPaseoConfig(tempDir);
    expect(original).toEqual({ ok: true, config: { worktree: { setup: ["old"], teardown: [] } } });
    await writeFile(configPath, "{ malformed");
    expect(await readPaseoConfigForEdit(tempDir)).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
    await writeFile(configPath, JSON.stringify({ worktree: { setup: "repaired" } }));
    expect(await readPaseoConfig(tempDir)).toEqual({
      ok: true,
      config: { worktree: { setup: ["repaired"], teardown: [] } },
    });
    await rm(configPath);
    expect(await readPaseoConfigForEdit(tempDir)).toEqual({
      ok: true,
      config: null,
      revision: null,
    });
  });

  it("serializes competing edits so exactly one matching revision commits", async () => {
    const results = await Promise.all(
      ["first", "second"].map((setup) =>
        writePaseoConfigForEdit({
          repoRoot: tempDir,
          config: { worktree: { setup } },
          expectedRevision: null,
        }),
      ),
    );
    const saved = await readPaseoConfigForEdit(tempDir);
    expect(results[0]).toEqual(saved);
    expect(results[1]).toEqual({
      ok: false,
      error: {
        code: "stale_project_config",
        currentRevision: await statPaseoConfigPath(tempDir),
      },
    });
  });

  it("returns null config and revision when paseo.json is missing", async () => {
    const result = await readPaseoConfigForEdit(tempDir);

    expect(result).toEqual({ ok: true, config: null, revision: null });
  });

  it("returns invalid_project_config for invalid JSON", async () => {
    writeFileSync(join(tempDir, "paseo.json"), "{ invalid json\n");

    const result = await readPaseoConfigForEdit(tempDir);

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
  });

  it("preserves raw lifecycle string and array forms with a revision token", async () => {
    writeFileSync(
      join(tempDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "npm run reset"],
        },
      }),
    );

    const result = await readPaseoConfigForEdit(tempDir);

    expect(result).toEqual({
      ok: true,
      config: {
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "npm run reset"],
        },
      },
      revision: await statPaseoConfigPath(tempDir),
    });
  });

  it("keeps runtime lifecycle commands normalized for execution", async () => {
    writeFileSync(
      join(tempDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "", 42, "npm run reset"],
        },
      }),
    );

    expect(await getWorktreeSetupCommands(tempDir)).toEqual(["npm install"]);
    expect(await getWorktreeTeardownCommands(tempDir)).toEqual(["npm run clean", "npm run reset"]);
  });

  it("writes pretty JSON with a trailing newline when revision matches", async () => {
    writeFileSync(join(tempDir, "paseo.json"), JSON.stringify({ worktree: { setup: "old" } }));
    const expectedRevision = await statPaseoConfigPath(tempDir);

    const result = await writePaseoConfigForEdit({
      repoRoot: tempDir,
      config: { worktree: { setup: "npm install" } },
      expectedRevision,
    });

    expect(result).toEqual({
      ok: true,
      config: { worktree: { setup: "npm install" } },
      revision: await statPaseoConfigPath(tempDir),
    });
    expect(readFileSync(join(tempDir, "paseo.json"), "utf8")).toBe(
      '{\n  "worktree": {\n    "setup": "npm install"\n  }\n}\n',
    );
  });

  // POSIX-only: Windows mtime granularity can collapse the two revisions in this fixture.
  it.skipIf(isPlatform("win32"))(
    "rejects stale writes when the current revision changed before rename",
    async () => {
      writeFileSync(join(tempDir, "paseo.json"), JSON.stringify({ worktree: { setup: "old" } }));
      const expectedRevision = await statPaseoConfigPath(tempDir);
      writeFileSync(join(tempDir, "paseo.json"), JSON.stringify({ worktree: { setup: "new" } }));
      const currentRevision = await statPaseoConfigPath(tempDir);

      const result = await writePaseoConfigForEdit({
        repoRoot: tempDir,
        config: { worktree: { setup: "from editor" } },
        expectedRevision,
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "stale_project_config", currentRevision },
      });
      expect(readFileSync(join(tempDir, "paseo.json"), "utf8")).toBe(
        JSON.stringify({ worktree: { setup: "new" } }),
      );
    },
  );

  it("round-trips unknown top-level, worktree, and script-entry fields", async () => {
    const config = {
      extraTop: { keep: true },
      worktree: {
        setup: ["npm install"],
        customWorktreeField: "preserve me",
      },
      scripts: {
        dev: {
          command: "npm run dev",
          type: "service",
          customScriptField: 123,
        },
      },
    };

    const result = await writePaseoConfigForEdit({
      repoRoot: tempDir,
      config,
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: true,
      config,
      revision: await statPaseoConfigPath(tempDir),
    });
    expect(await readPaseoConfigForEdit(tempDir)).toEqual({
      ok: true,
      config,
      revision: await statPaseoConfigPath(tempDir),
    });
  });

  it("returns write_failed for filesystem write exceptions", async () => {
    const fileRoot = join(tempDir, "not-a-directory");
    writeFileSync(fileRoot, "file");

    const result = await writePaseoConfigForEdit({
      repoRoot: fileRoot,
      config: { worktree: { setup: "npm install" } },
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "write_failed" },
    });
  });

  it("creates paseo.json when the file is still missing and expected revision is null", async () => {
    mkdirSync(join(tempDir, "nested"));

    const result = await writePaseoConfigForEdit({
      repoRoot: join(tempDir, "nested"),
      config: { scripts: { dev: { command: "npm run dev" } } },
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: true,
      config: { scripts: { dev: { command: "npm run dev" } } },
      revision: await statPaseoConfigPath(join(tempDir, "nested")),
    });
  });
});
