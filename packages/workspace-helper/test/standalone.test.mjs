import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const run = promisify(execFile);
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefixArgs =
  process.platform === "win32" ? [requireEnvironmentVariable("npm_execpath")] : [];
const packageRoot = path.resolve(import.meta.dirname, "..");

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to invoke npm on Windows`);
  return value;
}

function runNpm(args, options) {
  return run(npmCommand, [...npmPrefixArgs, ...args], options);
}

test("packed helper works from a fresh project without monorepo source fallback", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-helper-standalone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packDirectory = path.join(root, "packs");
  const project = path.join(root, "project");
  await Promise.all([mkdir(packDirectory), mkdir(project)]);
  await runNpm(["run", "build"], { cwd: packageRoot });
  const packed = JSON.parse(
    (
      await runNpm(["pack", "--json", "--pack-destination", packDirectory], {
        cwd: packageRoot,
      })
    ).stdout,
  )[0].filename;
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: { "@getpaseo/workspace-helper": `file:${path.join(packDirectory, packed)}` },
    }),
  );
  await runNpm(["install", "--ignore-scripts"], { cwd: project });
  await writeFile(path.join(project, "notes.txt"), "before\n");

  const imported = JSON.parse(
    (
      await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import('@getpaseo/workspace-helper').then(m=>console.log(JSON.stringify({version:m.WORKSPACE_HELPER_PROTOCOL_VERSION,bin:m.workspaceHelperExecutable})))",
        ],
        { cwd: project },
      )
    ).stdout,
  );
  assert.equal(imported.version, 1);
  assert.match(imported.bin, /node_modules\/@getpaseo\/workspace-helper\/dist\/executable\.mjs$/u);
  const bin = path.join(project, "node_modules/.bin/paseo-workspace-helper");
  const described = JSON.parse((await run(bin, ["describe"], { cwd: project })).stdout);
  assert.deepEqual(described, {
    protocolVersion: 1,
    version: 1,
    capabilities: ["files", "watch", "resolve-command"],
  });
  assert.equal(
    JSON.parse((await run(bin, ["fs-stat", "--path", "notes.txt"], { cwd: project })).stdout)
      .status,
    "ready",
  );

  const watch = await import("node:child_process").then(({ spawn }) =>
    spawn(bin, ["watch"], { cwd: project, stdio: ["pipe", "pipe", "pipe"] }),
  );
  const output = [];
  watch.stdout.setEncoding("utf8");
  watch.stdout.on("data", (chunk) => output.push(chunk));
  watch.stdin.write(
    `${JSON.stringify({ protocolVersion: 1, type: "subscribe", id: "proof", paths: ["notes.txt"], recursive: false, ignoredPaths: [] })}\n`,
  );
  await until(() => output.join("").includes('"type":"subscribed"'));
  await writeFile(path.join(project, "notes.txt"), "after\n");
  await until(() => output.join("").includes('"type":"changed"'));
  watch.stdin.end(`${JSON.stringify({ protocolVersion: 1, type: "close" })}\n`);
  await new Promise((resolve, reject) => {
    watch.once("error", reject);
    watch.once("exit", resolve);
  });
  assert.equal(await readFile(path.join(project, "notes.txt"), "utf8"), "after\n");
});

async function until(condition) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for helper watch event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
