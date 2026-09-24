import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveZoxideBinary,
  resolveZoxideDataDir,
  ZoxideRecentDirectorySource,
} from "./zoxide.js";

interface StubScript {
  binary: string;
  captureFile: string;
}

function writeStubScript(
  directory: string,
  body: {
    version?: string;
    versionExitCode?: number;
    queryBody?: string;
  },
): StubScript {
  const binary = path.join(directory, "zoxide");
  const captureFile = path.join(directory, "capture.txt");
  const version = body.version ?? "zoxide 9.9.9";
  const versionExitCode = body.versionExitCode ?? 0;
  const queryBody = body.queryBody ?? "exit 0";
  writeFileSync(
    binary,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  printf '%s\\n' '${version}'`,
      `  exit ${versionExitCode}`,
      "fi",
      'if [ "$1" = "query" ]; then',
      `  printf '%s' "$5" > "${captureFile}"`,
      `  ${queryBody}`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(binary, 0o755);
  return { binary, captureFile };
}

describe("ZoxideRecentDirectorySource", () => {
  let root: string;
  let stubDir: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zoxide-source-root-")));
    stubDir = mkdtempSync(path.join(tmpdir(), "zoxide-source-stub-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  });

  function sourceWith(stub: StubScript, config: { enabled?: boolean } = {}) {
    return new ZoxideRecentDirectorySource(
      { path: stub.binary, ...config },
      { env: { ...process.env } },
    );
  }

  it("returns in-root directories in frecency order, dropping stale and outside-root entries", async () => {
    const inside = path.join(root, "Documents", "dev", "github", "hertzbeat");
    const second = path.join(root, "Documents", "dev", "paseo-notes");
    const missing = path.join(root, "gone", "missing");
    const outside = path.join(tmpdir(), "zoxide-source-outside");
    mkdirSync(inside, { recursive: true });
    mkdirSync(second, { recursive: true });
    const stub = writeStubScript(stubDir, {
      queryBody: `printf '%s\\n' '${inside}' '${missing}' '${outside}' 'relative/path' '${second}'`,
    });

    const paths = await sourceWith(stub).query({ query: "hz", root, limit: 10 });

    expect(paths).toEqual([inside, second]);
  });

  it("keeps frecency order and honours the limit", async () => {
    const first = path.join(root, "one");
    const second = path.join(root, "two");
    const third = path.join(root, "three");
    for (const dir of [first, second, third]) mkdirSync(dir, { recursive: true });
    const stub = writeStubScript(stubDir, {
      queryBody: `printf '%s\\n' '${first}' '${second}' '${third}'`,
    });

    const paths = await sourceWith(stub).query({ query: "o", root, limit: 2 });

    expect(paths).toEqual([first, second]);
  });

  it("skips a blank query without spawning a probe", async () => {
    const stub = writeStubScript(stubDir, { queryBody: "exit 0" });
    const source = sourceWith(stub);

    expect(await source.query({ query: "   ", root, limit: 10 })).toEqual([]);
    expect(source.isAvailable()).toBe(false);
  });

  it("stays unavailable and returns nothing when the probe fails", async () => {
    const stub = writeStubScript(stubDir, { versionExitCode: 1 });
    const source = sourceWith(stub);

    expect(await source.query({ query: "repo", root, limit: 10 })).toEqual([]);
    expect(source.isAvailable()).toBe(false);
  });

  it("returns nothing when the query exits non-zero", async () => {
    const stub = writeStubScript(stubDir, { queryBody: "exit 3" });
    const source = sourceWith(stub);

    expect(await source.query({ query: "repo", root, limit: 10 })).toEqual([]);
    expect(source.isAvailable()).toBe(true);
  });

  it("returns nothing when the query times out", async () => {
    const stub = writeStubScript(stubDir, { queryBody: "sleep 2" });
    const source = sourceWith(stub);

    const started = Date.now();
    expect(await source.query({ query: "repo", root, limit: 10 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("passes the query as a single argv element", async () => {
    const stub = writeStubScript(stubDir, { queryBody: "exit 0" });
    const keyword = "a b'c";

    await sourceWith(stub).query({ query: keyword, root, limit: 10 });

    expect(readFileSync(stub.captureFile, "utf8")).toBe(keyword);
  });

  it("does not spawn zoxide when disabled by config", async () => {
    const stub = writeStubScript(stubDir, { queryBody: "exit 0" });
    const source = sourceWith(stub, { enabled: false });

    expect(await source.query({ query: "repo", root, limit: 10 })).toEqual([]);
    expect(existsSync(stub.captureFile)).toBe(false);
  });

  it("logs the matched directories so the daemon log shows zoxide was used", async () => {
    const matched = path.join(root, "projects", "hertzbeat");
    mkdirSync(matched, { recursive: true });
    const stub = writeStubScript(stubDir, { queryBody: `printf '%s\\n' '${matched}'` });
    const info = vi.fn();
    const source = new ZoxideRecentDirectorySource(
      { path: stub.binary },
      { env: { ...process.env }, logger: { debug: vi.fn(), info } },
    );

    await source.query({ query: "hertzbeat", root, limit: 10 });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ source: "zoxide", query: "hertzbeat", count: 1, paths: [matched] }),
      "zoxide recent directories matched",
    );
  });
});

describe("zoxide binary resolution", () => {
  it("prefers an explicitly configured path", () => {
    expect(resolveZoxideBinary("/custom/zoxide", {})).toBe("/custom/zoxide");
  });

  it("reads the data dir from the environment when not configured", () => {
    expect(resolveZoxideDataDir(undefined, { _ZO_DATA_DIR: "/data/zoxide" })).toBe("/data/zoxide");
    expect(resolveZoxideDataDir(undefined, {})).toBeUndefined();
    expect(resolveZoxideDataDir("~/zoxide-data", {})).toBe(path.join(homedir(), "zoxide-data"));
  });
});
