import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import type { Logger } from "pino";
import { describe, expect, test } from "vitest";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { buildProviderRegistry } from "../provider-registry.js";
import type { AgentClient, AgentSession } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";

function isGajaeCodeInstalled(): boolean {
  try {
    return execFileSync("gjc", ["--version"], { encoding: "utf8" }).startsWith("gjc/");
  } catch {
    return false;
  }
}

function buildGajaeCodeProvider(logger: Logger) {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      "gajae-code": {
        extends: "acp",
        label: "Gajae Code",
        command: ["gjc", "acp"],
      },
    },
  });
  return registry["gajae-code"];
}

async function deleteGajaeCodeSession(sessionId: string): Promise<void> {
  const child = spawn("gjc", ["acp"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const connection = new ClientSideConnection(
    () => ({
      async requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate() {},
      async readTextFile() {
        return { content: "" };
      },
      async writeTextFile() {
        return {};
      },
    }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  let requestError: unknown = null;
  try {
    await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "Paseo local test", version: "dev" },
    });
    await connection.extMethod("session/delete", { sessionId });
  } catch (error) {
    requestError = error;
  }
  let termination: Awaited<ReturnType<typeof terminateWithTreeKill>> | null = null;
  try {
    termination = await terminateWithTreeKill(child, {
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 1_000,
    });
  } finally {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  if (requestError) {
    throw requestError;
  }
  if (termination === "kill-timeout") {
    throw new Error("Timed out terminating the Gajae Code cleanup process");
  }
}

async function withGajaeCodeClient<T>(
  tempDirectoryPrefix: string,
  run: (context: {
    client: AgentClient;
    cwd: string;
    provider: ReturnType<typeof buildGajaeCodeProvider>;
  }) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), tempDirectoryPrefix));
  const logger = createTestLogger();
  const provider = buildGajaeCodeProvider(logger);
  const client = provider.createClient(logger);

  try {
    return await run({ client, cwd, provider });
  } finally {
    try {
      await client.shutdown?.();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

async function closeAndDeleteGajaeCodeSession(session: AgentSession): Promise<void> {
  const sessionId = session.describePersistence()?.nativeHandle ?? null;
  try {
    await session.close();
  } finally {
    if (sessionId) {
      await deleteGajaeCodeSession(sessionId);
    }
  }
}

async function withGajaeCodeSession<T>(run: (session: AgentSession) => Promise<T>): Promise<T> {
  return withGajaeCodeClient("paseo-gajae-code-commands-", async ({ client, cwd }) => {
    const session = await client.createSession({ provider: "gajae-code", cwd });
    try {
      return await run(session);
    } finally {
      await closeAndDeleteGajaeCodeSession(session);
    }
  });
}

describe("Gajae Code ACP provider (local e2e)", () => {
  test.runIf(isGajaeCodeInstalled())(
    "discovers the real catalog through the registry without retaining its probe session",
    async () => {
      await withGajaeCodeClient("paseo-gajae-code-acp-", async ({ client, cwd, provider }) => {
        const catalog = await provider.fetchCatalog(
          { scope: "workspace", cwd, force: true, timeoutMs: 30_000 },
          client,
        );
        expect(catalog.models.length).toBeGreaterThan(0);
        for (const model of catalog.models) {
          expect(model.provider).toBe("gajae-code");
        }
        expect(catalog.modes).toEqual([
          { id: "default", label: "Default", description: undefined },
        ]);

        const sessions = await client.listImportableSessions?.({ cwd });
        expect(sessions).toEqual([]);
      });
    },
    45_000,
  );

  test.runIf(isGajaeCodeInstalled())(
    "waits for Gajae Code's asynchronous workflow commands",
    async () => {
      await withGajaeCodeSession(async (session) => {
        const commands = await session.listCommands?.();
        const commandNames = new Set<string>();
        for (const command of commands ?? []) {
          commandNames.add(command.name);
        }

        const defaultCommands = [
          "skill:deep-interview",
          "skill:ralplan",
          "skill:team",
          "skill:ultragoal",
        ];
        for (const command of defaultCommands) {
          expect(commandNames.has(command), command).toBe(true);
        }
        expect(await session.getAvailableModes()).toEqual([{ id: "default", label: "Default" }]);
      });
    },
    45_000,
  );
});
