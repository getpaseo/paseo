// QA matrix for the opt-in background git fetch.
//
// Every case gets its own temp git repo, its own temp PASEO_HOME with its own
// config.json, and its own isolated daemon on a random port. Nothing touches
// the real ~/.paseo or the real daemon.
//
// A case writes daemon.git.backgroundFetchIntervalMinutes and/or the
// environment variable, resolves them through the real loadConfig, starts a
// daemon with the resolved interval, then watches .git/FETCH_HEAD. Git rewrites
// that file on every fetch, including no-op ones, so its timestamp is a record
// that owes nothing to any log line.
//
// Run: npx tsx scripts/test-git-fetch-matrix.ts

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/server/config.js";
import { DaemonClient } from "../src/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../src/server/test-utils/paseo-daemon.js";

const ENV_KEY = "PASEO_GIT_BACKGROUND_FETCH_INTERVAL_MINUTES";
const CREATED_AT = "2026-08-25T00:00:00.000Z";
// A minute of interval plus room for the fetch itself, so a one-minute cadence
// shows two fetches and a two-minute cadence shows one.
const WATCH_MS = Number(process.env.PASEO_GIT_FETCH_MATRIX_WATCH_MS ?? "90000");

type CaseExpectation =
  | { kind: "refuses" }
  | { kind: "fetches"; min: number; max: number; description: string };

interface MatrixCase {
  label: string;
  /** Written to daemon.git.backgroundFetchIntervalMinutes; undefined leaves the key out. */
  configValue?: unknown;
  /** Set as the environment variable; undefined leaves it unset. */
  envValue?: string;
  expect: CaseExpectation;
}

interface CaseResult {
  label: string;
  resolvedMinutes: number | null;
  fetches: number | null;
  refusedWith: string | null;
  passed: boolean;
  detail: string;
}

interface Fixture {
  root: string;
  paseoHomeRoot: string;
  paseoHome: string;
  fetchHeadPath: string;
}

const CASES: MatrixCase[] = [
  {
    label: "1. config only, 1 minute",
    configValue: 1,
    expect: { kind: "fetches", min: 2, max: 3, description: "fetches about every 60s" },
  },
  {
    label: "2. env only, 1 minute",
    envValue: "1",
    expect: { kind: "fetches", min: 2, max: 3, description: "fetches about every 60s" },
  },
  {
    label: "3. config 1, env 2 - which wins",
    configValue: 1,
    envValue: "2",
    expect: {
      kind: "fetches",
      min: 1,
      max: 1,
      description: "env wins: one fetch at startup, none again before 120s",
    },
  },
  {
    label: "4. invalid config, valid env 1",
    configValue: "abc",
    envValue: "1",
    expect: { kind: "refuses" },
  },
  {
    label: "5. valid config 1, invalid env",
    configValue: 1,
    envValue: "not-a-number",
    expect: {
      kind: "fetches",
      min: 2,
      max: 3,
      description: "bad env ignored, config wins: fetches about every 60s",
    },
  },
  {
    label: "6. invalid config only, no env",
    configValue: "abc",
    expect: { kind: "refuses" },
  },
  {
    label: "7. invalid env only, no config key",
    envValue: "not-a-number",
    expect: {
      kind: "fetches",
      min: 0,
      max: 0,
      description: "bad env ignored, nothing set: no fetches",
    },
  },
  {
    label: "8. config far above the cap",
    configValue: 999_999,
    expect: {
      kind: "fetches",
      min: 1,
      max: 1,
      description: "capped at 1440 minutes: one fetch at startup, no timer storm",
    },
  },
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function seedFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "paseo-git-fetch-matrix-"));
  const repoRoot = join(root, "repo");
  const originRoot = join(root, "origin.git");
  const paseoHomeRoot = join(root, "home");
  const paseoHome = join(paseoHomeRoot, ".paseo");
  const projectsDir = join(paseoHome, "projects");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });

  git(root, "init", "--bare", originRoot);
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "matrix@example.com");
  git(repoRoot, "config", "user.name", "Fetch Matrix");
  writeFileSync(join(repoRoot, "README.md"), "fetch matrix\n");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-m", "initial");
  // A local bare remote keeps the fetch real and offline: no network, no keys.
  git(repoRoot, "remote", "add", "origin", originRoot);
  git(repoRoot, "push", "origin", "main");

  const projectId = "proj-git-fetch-matrix";
  writeFileSync(
    join(projectsDir, "projects.json"),
    JSON.stringify([
      {
        projectId,
        rootPath: repoRoot,
        kind: "git",
        displayName: "repo",
        projectKey: null,
        customName: null,
        customIconRevision: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
      },
    ]),
  );
  writeFileSync(
    join(projectsDir, "workspaces.json"),
    JSON.stringify([
      {
        workspaceId: "ws-git-fetch-matrix",
        projectId,
        cwd: repoRoot,
        kind: "local_checkout",
        displayName: "repo",
        title: null,
        branch: null,
        worktreeRoot: repoRoot,
        baseBranch: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: repoRoot,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
        autoArchivedChangeRequestUrl: null,
        pinnedAt: null,
      },
    ]),
  );

  return { root, paseoHomeRoot, paseoHome, fetchHeadPath: join(repoRoot, ".git", "FETCH_HEAD") };
}

function writeConfigFile(paseoHome: string, configValue: unknown): void {
  const gitSection =
    configValue === undefined ? {} : { git: { backgroundFetchIntervalMinutes: configValue } };
  writeFileSync(
    join(paseoHome, "config.json"),
    JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:0", ...gitSection } }, null, 2) +
      "\n",
    { mode: 0o600 },
  );
}

function caseEnv(envValue: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (envValue === undefined) {
    delete env[ENV_KEY];
  } else {
    env[ENV_KEY] = envValue;
  }
  return env;
}

function fetchHeadMtimeMs(fetchHeadPath: string): number | null {
  try {
    return statSync(fetchHeadPath).mtimeMs;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countFetches(fetchHeadPath: string, windowMs: number): Promise<number> {
  let last = fetchHeadMtimeMs(fetchHeadPath);
  let count = 0;
  const end = Date.now() + windowMs;
  while (Date.now() < end) {
    await delay(1_000);
    const current = fetchHeadMtimeMs(fetchHeadPath);
    if (current !== last) {
      count += 1;
      last = current;
      console.log(`    fetch #${count} at ${new Date().toISOString()}`);
    }
  }
  return count;
}

function judge(
  matrixCase: MatrixCase,
  observed: Omit<CaseResult, "passed" | "detail">,
): CaseResult {
  if (matrixCase.expect.kind === "refuses") {
    const passed = observed.refusedWith !== null;
    return {
      ...observed,
      passed,
      detail: passed
        ? `config refused: ${observed.refusedWith}`
        : "expected the config to be refused, but it loaded",
    };
  }
  if (observed.refusedWith !== null) {
    return {
      ...observed,
      passed: false,
      detail: `unexpected config refusal: ${observed.refusedWith}`,
    };
  }
  const { min, max, description } = matrixCase.expect;
  const fetches = observed.fetches ?? 0;
  return {
    ...observed,
    passed: fetches >= min && fetches <= max,
    detail: `${fetches} fetch(es) in ${WATCH_MS / 1000}s, expected ${min}-${max} (${description})`,
  };
}

async function runCase(matrixCase: MatrixCase): Promise<CaseResult> {
  console.log(`\n=== ${matrixCase.label}`);
  const fixture = seedFixture();
  writeConfigFile(fixture.paseoHome, matrixCase.configValue);
  const configLabel =
    matrixCase.configValue === undefined ? "absent" : JSON.stringify(matrixCase.configValue);
  const envLabel =
    matrixCase.envValue === undefined ? "unset" : JSON.stringify(matrixCase.envValue);
  console.log(`  config key: ${configLabel}, env: ${envLabel}`);

  try {
    let resolvedMinutes: number;
    try {
      resolvedMinutes = loadConfig(fixture.paseoHome, {
        env: caseEnv(matrixCase.envValue),
      }).backgroundGitFetchIntervalMinutes;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return judge(matrixCase, {
        label: matrixCase.label,
        resolvedMinutes: null,
        fetches: null,
        refusedWith: message.split("\n")[0] ?? message,
      });
    }
    console.log(`  resolved interval: ${resolvedMinutes} minute(s)`);

    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot: fixture.paseoHomeRoot,
      backgroundGitFetchIntervalMinutes: resolvedMinutes,
      cleanup: false,
      mcpEnabled: false,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      // Observation arms the fetch timer, and only a subscribed client observes
      // a workspace, so counting starts from an untouched FETCH_HEAD.
      await client.fetchWorkspaces({
        page: { limit: 10 },
        subscribe: { subscriptionId: "git-fetch-matrix" },
      });
      const fetches = await countFetches(fixture.fetchHeadPath, WATCH_MS);
      return judge(matrixCase, {
        label: matrixCase.label,
        resolvedMinutes,
        fetches,
        refusedWith: null,
      });
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(`Paseo background git fetch matrix, ${WATCH_MS / 1000}s watch window per case`);
  const results: CaseResult[] = [];
  for (const matrixCase of CASES) {
    const result = await runCase(matrixCase);
    results.push(result);
    console.log(`  [${result.passed ? "PASS" : "FAIL"}] ${result.detail}`);
  }

  const failed = results.filter((result) => !result.passed);
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  if (failed.length > 0) {
    throw new Error(`${failed.length} case(s) failed: ${failed.map((r) => r.label).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
