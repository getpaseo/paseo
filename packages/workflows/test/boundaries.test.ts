import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow, step, terminal } from "../src/dsl.js";
import {
  createWorkflowEngine,
  type IntegrationContext,
  type WorkflowIntegration,
  type WorkflowIR,
} from "../src/index.js";
import {
  createFakeAgentRunner,
  createFakeClock,
  createFakeGateSink,
  createMemoryIntegrationConnections,
  createMemoryIntegrationStorage,
  createMemoryWorkflowStore,
} from "../src/testing.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(packageDir, "src");

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(?:ts|mts|js|mjs)$/u.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

describe("hard mechanical boundaries", () => {
  it("exports ONLY the 5 agreed entrypoints and allows ONLY pure runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      readonly exports: Record<string, unknown>;
      readonly dependencies?: Record<string, string>;
    };

    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./dsl", "./ir", "./testing", "./yaml"]);

    const allowedDeps = new Set(["zod", "ajv", "js-yaml"]);
    const actualDeps = Object.keys(pkg.dependencies ?? {});
    expect(actualDeps.length).toBeGreaterThan(0);
    for (const dep of actualDeps) {
      expect(allowedDeps.has(dep), `disallowed runtime dependency "${dep}"`).toBe(true);
    }

    const forbiddenDeps = ["pg", "drizzle-orm", "react", "@octokit/rest", "@octokit/core"];
    for (const forbidden of forbiddenDeps) {
      expect(actualDeps).not.toContain(forbidden);
    }
  });

  it("contains zero Node builtin imports in src/ (including ./ir and ./dsl)", () => {
    const files = collectSourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const nodeImportPattern =
      /(?:from\s+["'](?:node:|fs|net|http|https|path|os|crypto|child_process|stream|worker_threads)["']|require\(["'](?:node:|fs|net|http|https|path|os|crypto|child_process)["']\))/gu;

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const matches = content.match(nodeImportPattern);
      expect(
        matches,
        `unexpected Node builtin import in ${path.relative(packageDir, file)}`,
      ).toBeNull();
    }
  });

  it("contains zero hardcoded provider or database names anywhere in packages/workflows/src/", () => {
    const files = collectSourceFiles(srcDir);
    const forbiddenProviders = ["github", "slack", "discord", "linear", "notion", "postgres"];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const provider of forbiddenProviders) {
        const pattern = new RegExp(`\\b${provider}\\b`, "i");
        expect(
          pattern.test(content),
          `forbidden hardcoded provider "${provider}" found in ${path.relative(packageDir, file)}`,
        ).toBe(false);
      }
    }
  });

  it("passes ONLY the narrow IntegrationContext (zero Database/SQL/engine handles) to integration hooks", async () => {
    // Compile-time type-level verification of exact IntegrationContext keys.
    type ExpectedKeys = "scopeId" | "storage" | "connections" | "ingest" | "fetch" | "log" | "now";
    type AssertExact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
    const _exactContextKeys: AssertExact<keyof IntegrationContext, ExpectedKeys> = true;
    expect(_exactContextKeys).toBe(true);

    const observedKeySets: string[][] = [];
    const expectedSortedKeys = [
      "connections",
      "fetch",
      "ingest",
      "log",
      "now",
      "scopeId",
      "storage",
    ];

    const recordCtx = (ctx: IntegrationContext): void => {
      observedKeySets.push(Object.keys(ctx).sort());
      const asRecord = ctx as unknown as Record<string, unknown>;
      expect(asRecord["db"]).toBeUndefined();
      expect(asRecord["database"]).toBeUndefined();
      expect(asRecord["sql"]).toBeUndefined();
      expect(asRecord["drizzle"]).toBeUndefined();
      expect(asRecord["store"]).toBeUndefined();
      expect(asRecord["engine"]).toBeUndefined();
    };

    const acme: WorkflowIntegration = {
      id: "acme",
      auth: {
        async mint(_scope, ctx) {
          recordCtx(ctx);
          return { leaseId: "lease_1", env: { ACME_TOKEN: "tok_1" } };
        },
        async revoke(_leaseId, ctx) {
          recordCtx(ctx);
        },
      },
      steps: {
        check: {
          inputSchema: z.object({ ticket: z.string() }),
          outcomes: ["ok"],
          async execute(input, ctx) {
            recordCtx(ctx);
            await ctx.storage.set("last_ticket", input["ticket"] as string, { ttlMs: 5_000 });
            const stored = await ctx.storage.get<string>("last_ticket");
            expect(stored).toBe("ACME-1");
            const conn = await ctx.connections.get("acme-main");
            expect(conn?.name).toBe("acme-main");
            return { status: "completed", outcome: "ok", output: { seen: stored ?? "" } };
          },
        },
      },
    };

    const ir = defineWorkflow({
      id: "boundary-ctx-check",
      on: { "acme.ping": {} },
      initial: "run_check",
      steps: {
        run_check: step.integration("acme.check", {
          auth: { acme: { connection: "acme-main" } },
          input: { ticket: "ACME-1" },
          on: { ok: terminal.done() },
        }),
      },
    });
    const roundTripped = JSON.parse(JSON.stringify(ir)) as WorkflowIR;

    const clock = createFakeClock();
    const engine = createWorkflowEngine({
      store: createMemoryWorkflowStore(),
      runner: createFakeAgentRunner(),
      gates: createFakeGateSink(),
      integrations: [acme],
      clock,
      scopeId: "tenant-a",
      storage: createMemoryIntegrationStorage(clock),
      connections: createMemoryIntegrationConnections([
        { id: "conn_1", name: "acme-main", integration: "acme" },
      ]),
      workflows: [roundTripped],
    });

    const run = await engine.start({ workflowId: "boundary-ctx-check" });
    expect(run.status).toBe("done");
    expect(observedKeySets.length).toBe(3); // mint + execute + revoke
    for (const keys of observedKeySets) {
      expect(keys).toEqual(expectedSortedKeys);
    }
  });

  it("enforces IntegrationStorage TTL expiry, listing, deletion, and lock serialization", async () => {
    const clock = createFakeClock("2026-06-01T00:00:00.000Z");
    const storage = createMemoryIntegrationStorage(clock);

    await storage.set("cache:a", { count: 1 }, { ttlMs: 1_000 });
    await storage.set("cache:b", { count: 2 });
    await storage.set("other:c", "hello");

    expect(await storage.get("cache:a")).toEqual({ count: 1 });
    expect((await storage.list("cache:")).map((e) => e.key).sort()).toEqual(["cache:a", "cache:b"]);

    clock.advance(1_000);
    expect(await storage.get("cache:a")).toBeUndefined();
    expect((await storage.list("cache:")).map((e) => e.key)).toEqual(["cache:b"]);

    await storage.delete("cache:b");
    expect(await storage.get("cache:b")).toBeUndefined();

    const order: string[] = [];
    const p1 = storage.withLock("lock-1", 5_000, async () => {
      order.push("start-1");
      await Promise.resolve();
      order.push("end-1");
      return "first";
    });
    const p2 = storage.withLock("lock-1", 5_000, async () => {
      order.push("start-2");
      order.push("end-2");
      return "second";
    });
    expect(await Promise.all([p1, p2])).toEqual(["first", "second"]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});
