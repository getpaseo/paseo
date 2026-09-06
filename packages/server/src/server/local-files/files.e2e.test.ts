import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, expect, test } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { LOCAL_FILE_MAX_BYTES } from "@getpaseo/protocol/project-local-files";
import { materializeLocalFiles } from "./files.js";

let daemon: TestPaseoDaemon;
let client: DaemonClient;
const roots: string[] = [];

beforeAll(async () => {
  daemon = await createTestPaseoDaemon();
  client = new DaemonClient({ url: "ws://127.0.0.1:" + daemon.port + "/ws", appVersion: "0.7.2" });
  await client.connect();
}, 60_000);
afterAll(async () => {
  await client?.close();
  await daemon?.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}
async function project(owner = client) {
  const root = mkdtempSync(join(tmpdir(), "paseo-local-files-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Local files test");
  writeFileSync(join(root, ".gitignore"), ".env*\nlocal/\n");
  writeFileSync(join(root, "README.md"), "test");
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", "init");
  const result = await owner.addProject(root);
  if (!result.project) throw new Error(result.error ?? "Project missing");
  return { root, projectId: result.project.projectId };
}
async function inspect(projectId: string, path = ".env") {
  const result = await client.inspectProjectLocalFiles({ projectId, paths: [path] });
  expect(result.error).toBeNull();
  return result.files[0]!;
}
function encode(value: string) {
  return Buffer.from(value).toString("base64");
}

test("imports opaque bytes, exposes only metadata in previews, and retries without replacing a newer copy", async () => {
  const target = await project();
  const bytes = Buffer.from([0, 255, 10, 128, 65]);
  expect((await inspect(target.projectId)).status).toBe("missing");
  const input = {
    projectId: target.projectId,
    path: ".env",
    expectedRevision: null,
    data: bytes.toString("base64"),
  };
  const result = await client.importProjectLocalFile(input);
  expect(result.error).toBeNull();
  expect(readFileSync(join(target.root, ".env")).equals(bytes)).toBe(true);
  if (process.platform !== "win32")
    expect(statSync(join(target.root, ".env")).mode & 0o777).toBe(0o600);
  expect(await inspect(target.projectId)).toEqual(result.file);
  expect((await client.importProjectLocalFile(input)).error).toBeNull();
  writeFileSync(join(target.root, ".env"), "external edit");
  expect((await client.importProjectLocalFile(input)).error).toBe("changed");
  expect(readFileSync(join(target.root, ".env"), "utf8")).toBe("external edit");
  expect(readdirSync(target.root).filter((name) => name.startsWith(".paseo-import-"))).toEqual([]);
});

test("only one concurrent replacement wins against the same revision", async () => {
  const target = await project();
  writeFileSync(join(target.root, ".env"), "original");
  const original = await inspect(target.projectId);
  const results = await Promise.all(
    ["first", "second"].map((value) =>
      client.importProjectLocalFile({
        projectId: target.projectId,
        path: ".env",
        expectedRevision: original.revision,
        data: encode(value),
      }),
    ),
  );
  expect(results.filter((result) => result.error === null)).toHaveLength(1);
  expect(results.filter((result) => result.error === "changed")).toHaveLength(1);
});

test("reads a selected source only at its expected revision and supports nested ignored files", async () => {
  const source = await project();
  const target = await project();
  mkdirSync(join(source.root, "local"));
  writeFileSync(join(source.root, "local/dev.env"), "TOKEN=fixture");
  const preview = await inspect(source.projectId, "local/dev.env");
  const readInput = {
    projectId: source.projectId,
    path: preview.path,
    expectedRevision: preview.revision!,
  };
  const read = await client.readProjectLocalFile(readInput);
  expect(read.error).toBeNull();
  const imported = await client.importProjectLocalFile({
    projectId: target.projectId,
    path: preview.path,
    expectedRevision: null,
    data: read.data!,
  });
  expect(imported.error).toBeNull();
  expect(readFileSync(join(target.root, preview.path), "utf8")).toBe("TOKEN=fixture");
  writeFileSync(join(source.root, preview.path), "TOKEN=changed");
  expect((await client.readProjectLocalFile(readInput)).error).toBe("changed");
});

test("rejects tracked files, traversal, symlinks, directories, and malformed base64", async () => {
  const target = await project();
  writeFileSync(join(target.root, ".env.tracked"), "tracked");
  git(target.root, "add", "-f", ".env.tracked");
  for (const path of ["README.md", ".env.tracked"]) {
    const result = await client.importProjectLocalFile({
      projectId: target.projectId,
      path,
      expectedRevision: null,
      data: encode("no"),
    });
    expect(result.error).toBe("not_ignored");
  }
  for (const path of [
    "../escape",
    "/absolute",
    ".git/config",
    "local/../escape",
    "local\\escape",
    "local/NUL",
    "paseo.json",
  ]) {
    const result = await client.importProjectLocalFile({
      projectId: target.projectId,
      path,
      expectedRevision: null,
      data: encode("no"),
    });
    expect(result.error).toBe("invalid_path");
  }
  mkdirSync(join(target.root, "local"));
  expect((await inspect(target.projectId, "local")).status).toBe("unsupported");
  if (process.platform !== "win32") {
    symlinkSync(join(target.root, "README.md"), join(target.root, ".env.link"));
    expect((await inspect(target.projectId, ".env.link")).status).toBe("unsupported");
    symlinkSync(tmpdir(), join(target.root, "local/link"));
    expect((await inspect(target.projectId, "local/link/escape")).status).toBe("unsupported");
  }
  expect(
    (
      await client.importProjectLocalFile({
        projectId: target.projectId,
        path: ".env",
        expectedRevision: null,
        data: "!!!!",
      })
    ).error,
  ).toBe("invalid_data");
});

test("reports large source files without reading or transmitting their content", async () => {
  const target = await project();
  writeFileSync(join(target.root, ".env.large"), Buffer.alloc(LOCAL_FILE_MAX_BYTES + 1));
  const result = await inspect(target.projectId, ".env.large");
  expect(result.status).toBe("too_large");
  expect(result.size).toBe(LOCAL_FILE_MAX_BYTES + 1);
  expect(result.revision).toBeNull();
});

test("unknown projects cannot be used as a filesystem scope", async () => {
  const result = await client.inspectProjectLocalFiles({ projectId: "/tmp" });
  expect(result.error).toBe("project_not_found");
});

test("configured files reach a new subdirectory worktree before setup and existing worktree files survive reruns", async () => {
  const repo = await project();
  const root = join(repo.root, "packages/app");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "app");
  writeFileSync(
    join(root, "paseo.json"),
    JSON.stringify({
      worktree: {
        localFiles: [".env"],
        setup: "node -e \"require('fs').copyFileSync('.env', 'setup-read.txt')\"",
      },
    }),
  );
  git(repo.root, "add", ".");
  git(repo.root, "-c", "commit.gpgsign=false", "commit", "-m", "app");
  writeFileSync(join(root, ".env"), "local-only");
  const result = await client.createWorkspace({
    source: { kind: "worktree", cwd: root, action: "branch-off", baseBranch: "main" },
  });
  expect(result.error).toBeNull();
  const cwd = result.workspace!.workspaceDirectory;
  await expect.poll(() => existsSync(join(cwd, "setup-read.txt")), { timeout: 30_000 }).toBe(true);
  expect(readFileSync(join(cwd, "setup-read.txt"), "utf8")).toBe("local-only");
  writeFileSync(join(cwd, ".env"), "workspace-specific");
  writeFileSync(join(root, ".env"), "source-updated");
  await materializeLocalFiles(root, cwd);
  expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("workspace-specific");
}, 60_000);

test("missing files require explicit acknowledgement and unsafe files are never skipped", async () => {
  const source = await project();
  const target = await project();
  writeFileSync(
    join(source.root, "paseo.json"),
    JSON.stringify({ worktree: { localFiles: [".env"] } }),
  );
  await expect(materializeLocalFiles(source.root, target.root)).rejects.toThrow("missing");
  await materializeLocalFiles(source.root, target.root, true);
  expect(existsSync(join(target.root, ".env"))).toBe(false);
  mkdirSync(join(source.root, ".env"));
  await expect(materializeLocalFiles(source.root, target.root, true)).rejects.toThrow(
    "unavailable",
  );
});

test("workspace creation carries the explicit missing-file acknowledgement through setup", async () => {
  const source = await project();
  writeFileSync(
    join(source.root, "paseo.json"),
    JSON.stringify({
      worktree: {
        localFiles: [".env"],
        setup: "node -e \"require('fs').writeFileSync('setup-ran', 'yes')\"",
      },
    }),
  );
  git(source.root, "add", "paseo.json");
  git(source.root, "-c", "commit.gpgsign=false", "commit", "-m", "configure");
  const result = await client.createWorkspace({
    source: {
      kind: "worktree",
      projectId: source.projectId,
      baseBranch: "main",
      skipMissingLocalFiles: true,
    },
  });
  expect(result.error).toBeNull();
  const cwd = result.workspace!.workspaceDirectory;
  await expect.poll(() => existsSync(join(cwd, "setup-ran")), { timeout: 30_000 }).toBe(true);
  expect(existsSync(join(cwd, ".env"))).toBe(false);
}, 60_000);

test("copies a maximum-size opaque file between two independent daemons", async () => {
  const otherDaemon = await createTestPaseoDaemon();
  const otherClient = new DaemonClient({
    url: "ws://127.0.0.1:" + otherDaemon.port + "/ws",
    appVersion: "0.7.2",
  });
  try {
    await otherClient.connect();
    const source = await project();
    const target = await project(otherClient);
    const bytes = Buffer.alloc(LOCAL_FILE_MAX_BYTES, 7);
    writeFileSync(join(source.root, ".env"), bytes);

    const preview = await inspect(source.projectId);

    const read = await client.readProjectLocalFile({
      projectId: source.projectId,
      path: ".env",
      expectedRevision: preview.revision!,
    });
    expect(read.error).toBeNull();

    const imported = await otherClient.importProjectLocalFile({
      projectId: target.projectId,
      path: ".env",
      expectedRevision: null,
      data: read.data!,
    });

    expect(imported.error).toBeNull();
    expect(readFileSync(join(target.root, ".env")).equals(bytes)).toBe(true);
  } finally {
    await otherClient.close();
    await otherDaemon.close();
  }
}, 60_000);
