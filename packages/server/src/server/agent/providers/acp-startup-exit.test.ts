import { describe, expect, test } from "vitest";

import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

// Exercise the public catalog API with a real child, including stdout EOF and
// stderr draining. No provider installation or external service is involved.
const failingCommand: [string, ...string[]] = [
  process.execPath,
  "-e",
  "process.stdin.once('data', () => { process.stderr.write('launcher failed: fixture startup error\\n'); process.exitCode = 1; process.stdin.destroy(); });",
];

describe("ACP catalog startup failures", () => {
  test("reports a process that exits during initialize with its stderr", async () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: failingCommand,
    });
    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: process.cwd(), force: true }),
    ).rejects.toThrow(/launcher failed: fixture startup error/);
  }, 5_000);

  test("session startup reports the same process exit with its stderr", async () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: failingCommand,
    });
    await expect(client.createSession({ provider: "acp", cwd: process.cwd() })).rejects.toThrow(
      /launcher failed: fixture startup error/,
    );
  }, 5_000);

  test("provider diagnostics report the startup exit instead of an initialize timeout", async () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: failingCommand,
      diagnosticPhaseTimeoutMs: 2_000,
    });
    const { diagnostic } = await client.getDiagnostic();
    expect(diagnostic).toContain(
      "ACP agent process exited before initialization completed (exit code 1)",
    );
    expect(diagnostic).toContain("launcher failed: fixture startup error");
    expect(diagnostic).not.toContain("initialize timed out");
  });

  test("a successful catalog probe still returns its models and closes cleanly", async () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: [
        process.execPath,
        "-e",
        `
        require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
          const request = JSON.parse(line);
          const result = request.method === 'initialize'
            ? { protocolVersion: 1, agentCapabilities: {} }
            : { sessionId: 'fixture', models: {
                currentModelId: 'fixture-model',
                availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }]
              } };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        });
      `,
      ],
    });
    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: process.cwd(),
      force: true,
    });
    expect(catalog.models).toEqual([
      expect.objectContaining({ id: "fixture-model", label: "Fixture model" }),
    ]);
  });
});
