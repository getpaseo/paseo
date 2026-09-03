import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const deliveryCompatibilityFiles = [
  "packages/protocol/src/client-capabilities.ts",
  "packages/protocol/src/deliveries.ts",
  "packages/protocol/src/messages.ts",
  "packages/client/src/daemon-client.ts",
  "packages/server/src/server/deliveries/delivery-ledger.ts",
  "packages/server/src/server/session.ts",
  "packages/server/src/server/websocket-server.ts",
];

const deliveryTag =
  /COMPAT\((durableDeliver(?:y[^)]*|ies)|legacyPullDelivery|deliveryPayloadTombstones)\):/;
const addedVersion = /added in v\d+\.\d+\.\d+/;
const removalDate = /remove after \d{4}-\d{2}-\d{2}/;
const clientFloor = /client floor >= v\d+\.\d+\.\d+/;
const daemonFloor = /daemon floor >= v\d+\.\d+\.\d+/;

function compatibilityCommentBlocks(source: string): string[] {
  const lines = source.split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!deliveryTag.test(lines[index] ?? "")) continue;
    const block = [lines[index] ?? ""];
    for (
      let next = index + 1;
      next < lines.length && /^\s*\/\//.test(lines[next] ?? "");
      next += 1
    ) {
      block.push(lines[next] ?? "");
      index = next;
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

describe("delivery compatibility annotations", () => {
  test("every delivery shim has an added version, date, and both actionable floors", async () => {
    const missing: string[] = [];
    for (const relativePath of deliveryCompatibilityFiles) {
      const source = await readFile(path.join(repoRoot, relativePath), "utf8");
      for (const block of compatibilityCommentBlocks(source)) {
        if (
          !addedVersion.test(block) ||
          !removalDate.test(block) ||
          !clientFloor.test(block) ||
          !daemonFloor.test(block)
        ) {
          missing.push(`${relativePath}: ${block.split("\n", 1)[0]}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
