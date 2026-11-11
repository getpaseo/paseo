import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { connectToDaemon } from "../../utils/client.js";
import { runPaseoCli, startTestDaemon } from "../../../tests/helpers/test-daemon.js";

describe("paseo logs JSON output", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let agentId: string;
  let host: string;

  beforeAll(async () => {
    await mkdir(".artifacts", { recursive: true });
    daemon = await startTestDaemon({
      paseoHome: await mkdtemp(resolve(".artifacts/logs-json-home-")),
      workDir: await mkdtemp(resolve(".artifacts/logs-json-work-")),
    });
    host = `127.0.0.1:${daemon.port}`;
    const client = await connectToDaemon({ target: { kind: "endpoint", host } });
    try {
      // Creating an idle agent needs no inference or external provider connection.
      const agent = await client.createAgent({
        provider: "claude",
        cwd: daemon.workDir,
        title: "JSON logs",
      });
      agentId = agent.id;
    } finally {
      await client.close();
    }
  }, 60_000);

  afterAll(async () => {
    await daemon?.stop();
  });

  it.each([
    { label: "top-level --json", args: ["logs", "--json"] },
    { label: "agent logs --json", args: ["agent", "logs", "--json"] },
    { label: "--format json alias", args: ["logs", "--format", "json"] },
  ])(
    "prints JSON through $label",
    async ({ args }) => {
      const result = await runPaseoCli(daemon, [...args, agentId, "--host", host]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ agentId, items: [] });
    },
    30_000,
  );
});
