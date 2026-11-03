import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

  test("invalid provider options reject without crashing the host process", async () => {
    const clientModule = new URL("./generic-acp-agent.ts", import.meta.url).href;
    const loggerModule = new URL("../../../test-utils/test-logger.ts", import.meta.url).href;
    const script = `
      import { GenericACPAgentClient } from ${JSON.stringify(clientModule)};
      import { createTestLogger } from ${JSON.stringify(loggerModule)};
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      });
      try {
        await client.fetchCatalog({
          scope: 'workspace', cwd: process.cwd(), force: true,
          providerOptions: { clientCapabilities: { fs: 'invalid' } },
        });
        throw new Error('Expected invalid options to reject');
      } catch (error) {
        if (error.name !== 'ZodError') throw error;
      }
      // Let child cleanup and Node's unhandled-rejection check complete.
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log('host stayed alive');
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { timeout: 10_000 },
    );
    expect(result.stdout).toContain("host stayed alive");
    expect(result.stderr).toBe("");
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
