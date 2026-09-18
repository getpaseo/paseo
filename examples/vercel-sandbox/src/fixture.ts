import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "@vercel/sandbox";
import type { SessionState } from "./types.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixture");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function seedFixture(sandbox: Sandbox, state: SessionState): Promise<void> {
  const files = ["package.json", "README.md", "src/math.mjs", "test/math.test.mjs"].map((rel) => ({
    path: join(state.repoPath, rel),
    content: readFileSync(join(FIXTURE_DIR, rel)),
  }));
  await sandbox.writeFiles(files);
  const git = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `cd ${shellQuote(state.repoPath)} && (git rev-parse --git-dir >/dev/null 2>&1 || git init -q) && git add -A && (git diff --cached --quiet || git -c user.email=test@example.com -c user.name=test commit -qm fixture)`,
    ],
  });
  if (git.exitCode !== 0) throw new Error(`fixture git init failed: ${await git.stderr()}`);
  const test = await sandbox.runCommand({ cmd: "npm", args: ["test"], cwd: state.repoPath });
  const out = await test.stdout();
  if (test.exitCode === 0)
    throw new Error(`fixture tests unexpectedly passed before the agent ran:\n${out}`);
  if (!/add/.test(out) && !/AssertionError/.test(out)) {
    throw new Error(`fixture failure is not the expected assertion:\n${out}`);
  }
}
