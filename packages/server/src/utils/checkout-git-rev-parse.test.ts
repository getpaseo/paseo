import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const VALID_WINDOWS_ROOT = String.raw`E:\project\node-ai`;
const OLD_GIT_PATH_FORMAT_ECHO = `--path-format=absolute\n${VALID_WINDOWS_ROOT}\n`;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-checkout-git-"));
  tempDirs.push(dir);
  return dir;
}

function gitResult(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
}

function normalizePathForPlatform(value: string): string {
  if (process.platform !== "win32") {
    return value;
  }
  return value.replace(/\\/g, "/").toLowerCase();
}

function gitCanonicalize(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

async function loadCheckoutGitWithRevParseTopLevelOutput(stdout: string) {
  vi.resetModules();

  const runGitCommand = vi.fn(async (args: string[]) => {
    if (args.join(" ") === "rev-parse --show-toplevel") {
      return gitResult(stdout);
    }

    if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
      return gitResult("main\n");
    }

    if (args.join(" ") === "status --porcelain") {
      return gitResult("");
    }

    if (args.join(" ") === "branch --format=%(refname:short)") {
      return gitResult("main\n");
    }

    throw new Error(`Unexpected git command: git ${args.join(" ")}`);
  });

  vi.doMock("./run-git-command.js", () => ({ runGitCommand }));

  const checkoutGit = await import("./checkout-git.js");
  return { getCheckoutStatus: checkoutGit.getCheckoutStatus, runGitCommand };
}

describe("checkout git rev-parse path handling", () => {
  afterEach(() => {
    vi.doUnmock("./run-git-command.js");
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the worktree root from a nested real git checkout", async () => {
    const repoRoot = makeTempDir();
    const nested = join(repoRoot, "packages", "server", "src");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });

    const { getCheckoutStatus } = await import("./checkout-git.js");
    const status = await getCheckoutStatus(nested);

    expect(status.isGit).toBe(true);
    if (!status.isGit) {
      throw new Error("Expected nested checkout to be detected as a git repository");
    }
    expect(normalizePathForPlatform(status.repoRoot)).toBe(
      normalizePathForPlatform(gitCanonicalize(repoRoot)),
    );
  });

  it("rejects multi-line rev-parse stdout and never calls the removed path-format command", async () => {
    // Pre-2.31 Git is difficult to install in CI; inject its multi-line stdout
    // shape at the exact production command boundary that consumes rev-parse.
    const { getCheckoutStatus, runGitCommand } =
      await loadCheckoutGitWithRevParseTopLevelOutput(OLD_GIT_PATH_FORMAT_ECHO);

    const status = await getCheckoutStatus(VALID_WINDOWS_ROOT);

    expect(status).toEqual({ isGit: false });
    expect(runGitCommand).toHaveBeenCalledWith(["rev-parse", "--show-toplevel"], expect.anything());
    expect(runGitCommand).not.toHaveBeenCalledWith(
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      expect.anything(),
    );
    expect(runGitCommand).not.toHaveBeenCalledWith(
      ["rev-parse", "--git-common-dir"],
      expect.anything(),
    );
  });
});
