import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersistedConfig } from "@getpaseo/server/configuration";
import { createOutputOptions } from "../../output/index.js";
import {
  defaultPathScriptPreviewDeps,
  runPathScriptPreviewCommandWithDeps,
  type PathScriptPreviewDeps,
  type PathScriptPreviewOptions,
} from "./path-script-preview.js";

const PASEO_HOME = "/home/u/.paseo";
const SCRIPT_PATH = "/opt/scripts/place-worktree";

function previewOptions(
  overrides: Partial<PathScriptPreviewOptions> = {},
): PathScriptPreviewOptions {
  return {
    daemonTarget: { kind: "instance", home: PASEO_HOME },
    path: "/src/acme/widgets",
    branch: "feature/New Thing",
    ...overrides,
  };
}

function configWithScript(scriptPath: string | null): PersistedConfig {
  return (scriptPath === null ? {} : { worktrees: { pathScript: scriptPath } }) as PersistedConfig;
}

function fakeDeps(
  gitOutputs: Record<string, string>,
  scriptPath: string | null = SCRIPT_PATH,
): PathScriptPreviewDeps & { gitCalls: Array<{ args: string[]; cwd: string }> } {
  const gitCalls: Array<{ args: string[]; cwd: string }> = [];
  return {
    gitCalls,
    readConfig: () => configWithScript(scriptPath),
    runGit: async (args, cwd) => {
      gitCalls.push({ args, cwd });
      const output = gitOutputs[args.join(" ")];
      if (output === undefined) throw new Error(`unexpected git ${args.join(" ")}`);
      return output;
    },
  };
}

const GIT_OUTPUTS = {
  "rev-parse --git-common-dir": "/src/acme/widgets/.git\n",
  remote: "origin\nupstream\n",
  "remote get-url origin": "git@github.com:acme/widgets.git\n",
};

describe("runPathScriptPreviewCommandWithDeps", () => {
  it("returns the script path and all 10 inputs in order", async () => {
    const result = await runPathScriptPreviewCommandWithDeps(
      previewOptions({ baseRef: "main" }),
      fakeDeps(GIT_OUTPUTS),
    );

    expect(result.type).toBe("single");
    expect(result.data).toEqual({
      scriptPath: SCRIPT_PATH,
      configPath: path.join(PASEO_HOME, "config.json"),
      cwd: "/src/acme/widgets",
      argv: [
        "/src/acme/widgets",
        "widgets",
        "acme",
        "widgets",
        "feature/New Thing",
        "feature-new-thing",
        result.data.argv[6],
        "branch-off",
        "main",
        PASEO_HOME,
      ],
      env: expect.objectContaining({
        PASEO_REPO_PATH: "/src/acme/widgets",
        PASEO_BRANCH_NAME: "feature/New Thing",
        PASEO_HOME,
      }),
    });
    expect(result.data.argv[6]).toHaveLength(8);
  });

  it("renders the script, inputs, and the not-executed notice", async () => {
    const result = await runPathScriptPreviewCommandWithDeps(
      previewOptions(),
      fakeDeps(GIT_OUTPUTS),
    );
    const rendered = result.schema.renderHuman!(result, createOutputOptions());

    expect(rendered).toContain(`Script: ${SCRIPT_PATH}`);
    expect(rendered).toContain("reflects config on disk");
    expect(rendered).toContain("Not executed");
    expect(rendered).toContain("  $1  /src/acme/widgets");
    expect(rendered).toContain("  $10  " + PASEO_HOME);
    expect(rendered).toContain("  PASEO_BRANCH_NAME=feature/New Thing");
  });

  it("fails when worktrees.pathScript is unset", async () => {
    await expect(
      runPathScriptPreviewCommandWithDeps(previewOptions(), fakeDeps(GIT_OUTPUTS, null)),
    ).rejects.toMatchObject({
      code: "PATH_SCRIPT_NOT_SET",
      message: `worktrees.pathScript is not set in ${path.join(PASEO_HOME, "config.json")}`,
    });
  });

  it("requires a local daemon home", async () => {
    await expect(
      runPathScriptPreviewCommandWithDeps(
        previewOptions({ daemonTarget: { kind: "endpoint", host: "example.test:1" } }),
        fakeDeps(GIT_OUTPUTS),
      ),
    ).rejects.toMatchObject({ code: "LOCAL_DAEMON_REQUIRED" });
  });

  it("rejects unknown modes", async () => {
    await expect(
      runPathScriptPreviewCommandWithDeps(previewOptions({ mode: "fork" }), fakeDeps(GIT_OUTPUTS)),
    ).rejects.toMatchObject({ code: "INVALID_MODE" });
  });

  it("uses empty owner and remote when there is no remote", async () => {
    const result = await runPathScriptPreviewCommandWithDeps(
      previewOptions(),
      fakeDeps({ "rev-parse --git-common-dir": "/src/acme/widgets/.git", remote: "" }),
    );
    expect(result.data.argv.slice(2, 4)).toEqual(["", ""]);
  });

  it("never runs the configured script: git is the only process it touches", async () => {
    const deps = fakeDeps(GIT_OUTPUTS);
    await runPathScriptPreviewCommandWithDeps(previewOptions(), deps);

    expect(deps.gitCalls.length).toBeGreaterThan(0);
    for (const call of deps.gitCalls) {
      expect(call.args.join(" ")).not.toContain(SCRIPT_PATH);
      expect(call.args[0]).toMatch(/^(rev-parse|remote)$/);
    }
  });
});

describe("runPathScriptPreviewCommandWithDeps with real git", () => {
  let tmp: string;
  let sentinel: string;
  let repo: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "paseo-path-script-preview-"));
    sentinel = path.join(tmp, "script-ran");
    repo = path.join(tmp, "src", "acme", "widgets");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
      cwd: repo,
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("derives git inputs from the repo and does not execute the script", async () => {
    // A script that would leave a sentinel if anything ran it.
    const script = path.join(tmp, "place-worktree.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\necho /nope\n`, {
      mode: 0o755,
    });

    const result = await runPathScriptPreviewCommandWithDeps(
      previewOptions({ path: repo, branch: "topic" }),
      {
        ...defaultPathScriptPreviewDeps,
        readConfig: () => configWithScript(script),
      },
    );

    expect(result.data.scriptPath).toBe(script);
    const realRepo = realpathSync(repo);
    expect(result.data.cwd).toBe(realRepo);
    expect(result.data.argv.slice(0, 5)).toEqual([realRepo, "widgets", "acme", "widgets", "topic"]);
    expect(existsSync(sentinel)).toBe(false);
  });
});
