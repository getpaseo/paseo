import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { ensureForgeCli, type EnsureForgeCliOptions } from "./ensure-forge-cli.js";

const logger = pino({ level: "silent" });

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-forge-cli-"));
}

function fakeResponse(body: Buffer, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  return new Response(new Uint8Array(body), { status });
}

/** A bare-binary asset (tea-shaped): the "download" is a shell script printing a version. */
function makeBareBinaryFetch(): typeof fetch {
  const script = "#!/bin/sh\necho 'tea version 0.3.0'\n";
  const body = Buffer.from(script, "utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async () => fakeResponse(body)) as any;
}

/** A tar.gz asset (gh/glab-shaped): builds a real tarball containing a fake gh binary. */
function makeTarGzFetch(binaryRelPath: string): typeof fetch {
  const stageDir = makeTmpDir();
  const binaryAbsPath = path.join(stageDir, binaryRelPath);
  mkdirSync(path.dirname(binaryAbsPath), { recursive: true });
  writeFileSync(binaryAbsPath, "#!/bin/sh\necho 'gh version 2.96.0'\n");
  execFileSync("chmod", ["+x", binaryAbsPath]);

  const archivePath = path.join(stageDir, "asset.tar.gz");
  execFileSync("tar", ["czf", archivePath, "-C", stageDir, binaryRelPath.split("/")[0] ?? "."]);
  const tarball = execFileSync("cat", [archivePath]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async () => fakeResponse(tarball)) as any;
}

function baseOptions(overrides: Partial<EnsureForgeCliOptions> = {}): EnsureForgeCliOptions {
  return {
    paseoHome: makeTmpDir(),
    logger,
    probeExecutableImpl: async () => true,
    ...overrides,
  };
}

describe("ensureForgeCli", () => {
  test("returns the cached path without downloading when it already probes ok", async () => {
    const paseoHome = makeTmpDir();
    const cliPath = path.join(paseoHome, "tools", "tea", "tea");
    mkdirSync(path.dirname(cliPath), { recursive: true });
    writeFileSync(cliPath, "#!/bin/sh\necho ok\n");

    let fetchCalls = 0;
    const fetchImpl: typeof fetch = (async () => {
      fetchCalls += 1;
      throw new Error("should not fetch when cache hits");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const result = await ensureForgeCli("tea", {
      paseoHome,
      logger,
      fetchImpl,
      probeExecutableImpl: async () => true,
    });

    expect(result).toBe(cliPath);
    expect(fetchCalls).toBe(0);
  });

  test("returns null for an unsupported arch without touching the network", async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = (async () => {
      fetchCalls += 1;
      throw new Error("should not fetch for unsupported arch");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const result = await ensureForgeCli(
      "tea",
      baseOptions({
        fetchImpl,
        probeExecutableImpl: async () => false,
        arch: "ia32",
      }),
    );

    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test("downloads a bare binary (tea-shaped), chmods it, and probes it", async () => {
    const paseoHome = makeTmpDir();
    let probeCallCount = 0;

    const result = await ensureForgeCli("tea", {
      paseoHome,
      logger,
      fetchImpl: makeBareBinaryFetch(),
      probeExecutableImpl: async (executablePath) => {
        probeCallCount += 1;
        // First probe (cache check) reports absent so we take the download
        // path; second probe (post-download verification) succeeds.
        if (probeCallCount === 1) return false;
        expect(executablePath).toBe(path.join(paseoHome, "tools", "tea", "tea"));
        return true;
      },
    });

    const expectedPath = path.join(paseoHome, "tools", "tea", "tea");
    expect(result).toBe(expectedPath);

    const stats = await stat(expectedPath);
    expect(stats.mode & 0o777).toBe(0o755);

    const contents = await readFile(expectedPath, "utf8");
    expect(contents).toContain("tea version 0.3.0");
  });

  test("downloads and extracts a tar.gz asset (gh-shaped) from the archive", async () => {
    const paseoHome = makeTmpDir();
    let probeCallCount = 0;

    const result = await ensureForgeCli("gh", {
      paseoHome,
      logger,
      fetchImpl: makeTarGzFetch("gh_2.96.0_linux_amd64/bin/gh"),
      probeExecutableImpl: async () => {
        probeCallCount += 1;
        return probeCallCount > 1;
      },
      platform: "linux",
      arch: "x64",
    });

    const expectedPath = path.join(paseoHome, "tools", "gh", "gh");
    expect(result).toBe(expectedPath);

    const contents = await readFile(expectedPath, "utf8");
    expect(contents).toContain("gh version 2.96.0");
  });

  test("cleans up and returns null when the post-download probe fails", async () => {
    const paseoHome = makeTmpDir();

    const result = await ensureForgeCli("tea", {
      paseoHome,
      logger,
      fetchImpl: makeBareBinaryFetch(),
      probeExecutableImpl: async () => false,
    });

    expect(result).toBeNull();

    const expectedPath = path.join(paseoHome, "tools", "tea", "tea");
    await expect(stat(expectedPath)).rejects.toThrow();
  });

  test("dedupes concurrent calls for the same cli into a single download", async () => {
    const paseoHome = makeTmpDir();
    let fetchCalls = 0;
    let probeCallCount = 0;

    const fetchImpl: typeof fetch = (async () => {
      fetchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const script = "#!/bin/sh\necho 'tea version 0.3.0'\n";
      return fakeResponse(Buffer.from(script, "utf8"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const options: EnsureForgeCliOptions = {
      paseoHome,
      logger,
      fetchImpl,
      probeExecutableImpl: async () => {
        probeCallCount += 1;
        // First probe is the shared cache check (miss); second is the
        // post-download verification (success).
        return probeCallCount > 1;
      },
    };

    const [first, second] = await Promise.all([
      ensureForgeCli("tea", options),
      ensureForgeCli("tea", options),
    ]);

    expect(first).toBe(path.join(paseoHome, "tools", "tea", "tea"));
    expect(second).toBe(first);
    expect(fetchCalls).toBe(1);
  });
});
