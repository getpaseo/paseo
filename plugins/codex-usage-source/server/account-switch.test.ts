import { expect, test } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UsageSourceRegistry } from "../../../packages/server/src/server/plugins/usage-sources/index.js";
import { discover, fetchUsage } from "./usage.js";
import { inputSchema } from "../shared/input.js";

test.each(["opencode", "codex"])(
  "agent usage refresh follows a changed %s login identity",
  async (provider) => {
    await mkdir(join(process.cwd(), ".artifacts"), { recursive: true });
    const home = await mkdtemp(join(process.cwd(), ".artifacts/account-switch-"));
    const databasePath = join(home, "opencode.db");
    const env = { HOME: home, CODEX_HOME: home, OPENCODE_DB: databasePath };
    const lookup = { home, env };
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(
        "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)",
      );
      const insert = db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, 1, 1)");
      for (const account of ["a", "b"])
        insert.run(
          account,
          "openai",
          JSON.stringify({
            type: "oauth",
            access: `fixture-${account}`,
            metadata: { accountID: account },
            expires: Date.now() + 60000,
          }),
          account === "a" ? 1 : 0,
        );
      await writeFile(
        join(home, "auth.json"),
        JSON.stringify({ tokens: { access_token: "fixture-a", account_id: "a" } }),
      );
      const session = { provider, model: "openai/gpt-5", sessionKey: "same-session", env };
      const registry = new UsageSourceRegistry(Date.now, 300000, undefined, {
        hasAgent: (id) => id === "agent",
        usageSession: () => session,
      });
      registry.register({
        id: "codex",
        label: "Codex",
        discover: (scope) =>
          scope.kind === "session" ? discover(scope, lookup) : Promise.resolve([]),
        fetch: (input) =>
          fetchUsage(
            inputSchema.parse(input),
            async () =>
              Response.json({
                plan_type: "plus",
                rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
              }),
            lookup,
          ),
      });
      expect(
        (await registry.listReports({ agentId: "agent" })).map((entry) => ({
          id: entry.id,
          status: entry.report.status,
        })),
      ).toEqual([{ id: "codex:a", status: "available" }]);
      db.exec("UPDATE credential SET active = CASE WHEN id = 'b' THEN 1 ELSE 0 END");
      await writeFile(
        join(home, "auth.json"),
        JSON.stringify({ tokens: { access_token: "fixture-b", account_id: "b" } }),
      );
      expect(
        (await registry.listReports({ agentId: "agent", forceRefresh: true })).map((entry) => ({
          id: entry.id,
          status: entry.report.status,
        })),
      ).toEqual([{ id: "codex:b", status: "available" }]);
    } finally {
      db.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
