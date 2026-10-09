import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Opt-in reproduction: prepare the directory tree with scripts/repro-directory-search-memory.py,
// then pass its location as PASEO_REPRO_SEARCH_ROOT. This exercises real filesystem calls.
it.skipIf(!process.env.PASEO_REPRO_SEARCH_ROOT)(
  "finishes overlapping directory searches without exhausting the Node heap",
  async () => {
    const modulePath = fileURLToPath(new URL("./directory-suggestions.ts", import.meta.url));
    const source = `
      const { searchDirectoryEntries } = await import(${JSON.stringify(modulePath)});
      const query = "zzzzzzzzzzzzzz";
      await Promise.all(Array.from({ length: query.length }, (_, index) =>
        searchDirectoryEntries({
          root: process.env.PASEO_REPRO_SEARCH_ROOT,
          query: query.slice(0, index + 1),
          pathFormat: "absolute",
          includeFiles: false,
          includeDirectories: true,
          pathQueryPolicy: "rooted",
          rootAliases: ["~"],
          blankQueryBehavior: "none",
          confidentResultScanThreshold: 5000,
          limit: 30,
        })
      ));
    `;
    const result = await new Promise<{
      code: number | null;
      signal: string | null;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", source],
        {
          stdio: ["ignore", "ignore", "pipe"],
          env: process.env,
        },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data: string) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stderr }));
    });
    expect(result.stderr).not.toContain("JavaScript heap out of memory");
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
  },
  120_000,
);
