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

const knownShimSites = [
  {
    relativePath: "packages/protocol/src/deliveries.ts",
    marker: "targetAgentId: DeliveryTargetAgentIdSchema.optional(),",
    tag: "durableDeliveryTarget",
  },
  {
    relativePath: "packages/server/src/server/deliveries/delivery-ledger.ts",
    marker: "if (parsed.targetAgentId === undefined && !legacyPull)",
    tag: "durableDeliveryTarget",
  },
  {
    relativePath: "packages/server/src/server/deliveries/delivery-ledger.ts",
    marker: "const legacyPull =",
    tag: "durableDeliveryTarget",
  },
  {
    relativePath: "packages/server/src/server/session.ts",
    marker: "const targetAgentId =",
    tag: "durableDeliveryTarget",
  },
  {
    relativePath: "packages/server/src/server/session.ts",
    marker: "function sessionRequestId(message: SessionInboundMessage)",
    tag: "durableDeliveryRequestCorrelation",
  },
  {
    relativePath: "packages/server/src/server/websocket-server.ts",
    marker: "function extractRequestInfoFromUnknownWsInbound(",
    tag: "durableDeliveryRequestCorrelation",
  },
  {
    relativePath: "packages/client/src/daemon-client.ts",
    marker: "function extractCorrelatedResponseIdentity(input: unknown)",
    tag: "durableDeliveryRequestCorrelation",
  },
  {
    relativePath: "packages/client/src/daemon-client.ts",
    marker: "private async sendCorrelatedRequest<",
    tag: "durableDeliveryRequestCorrelation",
  },
];

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

  test("keeps the known acceptance and correlation shims explicitly annotated", async () => {
    const missing: string[] = [];
    for (const site of knownShimSites) {
      const source = await readFile(path.join(repoRoot, site.relativePath), "utf8");
      const markerIndex = source.indexOf(site.marker);
      if (markerIndex < 0) {
        missing.push(`${site.relativePath}: missing marker ${site.marker}`);
        continue;
      }
      const nearby = source.slice(Math.max(0, markerIndex - 600), markerIndex);
      if (!nearby.includes(`COMPAT(${site.tag}):`)) {
        missing.push(`${site.relativePath}: ${site.tag} before ${site.marker}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
