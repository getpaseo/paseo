import type { z } from "zod";
import type {
  ProviderInput,
  ProviderLaunch,
  ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";
import { MspConnection } from "./connection.js";
import { sessionListSchema } from "./wire.js";

export class Sessions {
  private readonly hosts = new Set<MspConnection>();
  async list(
    launch: ProviderLaunch,
    input: Extract<ProviderInput, { type: "sessions" }>,
  ): Promise<ProviderSessionSummary[]> {
    const host = new MspConnection({ launch });
    this.hosts.add(host);
    try {
      await host.initialize();
      const summaries: ProviderSessionSummary[] = [];
      let cursor: string | null = null;
      do {
        const page: z.infer<typeof sessionListSchema> = await host.request(
          "session/list",
          { workspaceRoot: input.cwd, limit: Math.min(input.limit ?? 50, 200), cursor },
          sessionListSchema,
        );
        for (const session of page.sessions) {
          if (session.workspaceRoot === null) continue;
          if (
            input.query &&
            !(session.title ?? "").toLowerCase().includes(input.query.toLowerCase())
          )
            continue;
          summaries.push({
            cwd: session.workspaceRoot,
            title: session.title,
            updatedAt: session.updatedAt,
            persistence: {
              version: 1,
              data: {
                sessionId: session.sessionId,
                ...(session.modelId === null ? {} : { model: session.modelId }),
              },
            },
          });
          if (input.limit && summaries.length >= input.limit) return summaries;
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      return summaries;
    } finally {
      await host.close();
      this.hosts.delete(host);
    }
  }
  async close(): Promise<void> {
    await Promise.all([...this.hosts].map((host) => host.close()));
  }
}
