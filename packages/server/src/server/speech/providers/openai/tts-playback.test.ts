import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("prefetched speech survives garbage collection until its playback turn", () => {
  const fixture = fileURLToPath(new URL("./test-utils/prefetched-playback.ts", import.meta.url));
  const output = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", fixture], {
    encoding: "utf8",
    timeout: 15_000,
  });

  const result = JSON.parse(output);
  expect(result.requests.sort()).toEqual(
    ["First sentence.", "Second sentence.", "Third sentence."].sort(),
  );
  expect(result.emitted).toEqual([
    { bytes: 192_000, value: 1, format: "pcm" },
    { bytes: 192_000, value: 2, format: "pcm" },
    { bytes: 192_000, value: 3, format: "pcm" },
  ]);
});
