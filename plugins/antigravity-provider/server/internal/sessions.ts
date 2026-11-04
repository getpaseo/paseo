import os from "node:os";
import type {
  ProviderInput,
  ProviderLaunch,
  ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";
import { canonicalPath, DriverProcess } from "./process.js";
import { acpInitializeResultSchema, acpSessionListResultSchema } from "./wire.js";

export class Sessions {
  private readonly activeDrivers = new Set<DriverProcess>();

  async list(
    launch: ProviderLaunch,
    input: Extract<ProviderInput, { type: "sessions" }>,
  ): Promise<ProviderSessionSummary[]> {
    const driver = new DriverProcess(
      { launch, cwd: os.tmpdir() },
      {
        onNotification: () => {},
        onRequest: (id, method) =>
          driver.respondError(id, -32601, `Unsupported client method: ${method}`),
        onExit: () => {},
      },
    );
    this.activeDrivers.add(driver);
    try {
      await driver.requestInit(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "paseo", version: "1.0.0" },
        },
        acpInitializeResultSchema,
      );

      const summaries: ProviderSessionSummary[] = [];
      const seen = new Set<string>();
      const targetCwd = input.cwd ? canonicalPath(input.cwd) : null;
      const query = input.query?.trim().toLowerCase() || null;
      let cursor: string | undefined;

      do {
        const page = await driver.requestInit(
          "session/list",
          {
            ...(targetCwd ? { cwd: targetCwd } : {}),
            ...(cursor ? { cursor } : {}),
          },
          acpSessionListResultSchema,
        );

        for (const entry of page.sessions) {
          if (seen.has(entry.sessionId)) continue;
          seen.add(entry.sessionId);
          if (!matchesSessionFilter(entry, targetCwd, query)) continue;

          summaries.push({
            cwd: entry.cwd,
            ...(entry.title ? { title: entry.title } : {}),
            ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
            persistence: { version: 1, data: { conversationId: entry.sessionId } },
          });
          if (input.limit && summaries.length >= input.limit) return summaries;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      return summaries;
    } finally {
      this.activeDrivers.delete(driver);
      await driver.stop();
    }
  }

  async close(): Promise<void> {
    const drivers = [...this.activeDrivers];
    this.activeDrivers.clear();
    await Promise.all(drivers.map((driver) => driver.stop()));
  }
}

function matchesSessionFilter(
  entry: { cwd: string; title?: string | null },
  targetCwd: string | null,
  query: string | null,
): boolean {
  if (targetCwd && canonicalPath(entry.cwd) !== targetCwd) return false;
  if (!query) return true;
  return `${entry.title ?? ""}\n${entry.cwd}`.toLowerCase().includes(query);
}
