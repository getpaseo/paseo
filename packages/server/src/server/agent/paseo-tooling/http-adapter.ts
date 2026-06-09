import type express from "express";
import type { Logger } from "pino";
import { z } from "zod";

import type { AgentProvider } from "../agent-sdk-types.js";
import type { PaseoToolRegistry } from "./registry.js";
import type { PaseoToolingRuntime } from "./runtime.js";

const ToolExecuteBodySchema = z.object({
  provider: z.string().min(1),
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  input: z.unknown().optional(),
});

export interface MountPaseoToolingHttpAdapterOptions {
  app: express.Express;
  registry: PaseoToolRegistry;
  runtime: PaseoToolingRuntime;
  logger: Logger;
}

export function mountPaseoToolingHttpAdapter(options: MountPaseoToolingHttpAdapterOptions): void {
  const { app, registry, runtime, logger } = options;
  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (req.header("authorization") === `Bearer ${runtime.token}`) {
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
  };

  app.get("/api/paseo-tooling/manifest", requireAuth, (_req, res) => {
    res.json({ tools: registry.listManifest() });
  });

  const runExecuteRequest = async (req: express.Request, res: express.Response): Promise<void> => {
    const parsed = ToolExecuteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const callerAgentId = runtime.resolveProviderSession({
      provider: parsed.data.provider as AgentProvider,
      sessionId: parsed.data.sessionId,
    });
    if (!callerAgentId) {
      res.status(404).json({ error: "Provider session is not bound to a Paseo agent" });
      return;
    }

    try {
      const result = await registry.executeTool({
        name: parsed.data.tool,
        input: parsed.data.input ?? {},
        callerAgentId,
      });
      res.json({ output: formatPaseoToolResult(result) });
    } catch (err) {
      logger.error(
        {
          err,
          provider: parsed.data.provider,
          sessionId: parsed.data.sessionId,
          tool: parsed.data.tool,
        },
        "Paseo tooling HTTP execution failed",
      );
      res.status(500).json({ error: err instanceof Error ? err.message : "Tool execution failed" });
    }
  };

  app.post("/api/paseo-tooling/execute", requireAuth, (req, res) => {
    void runExecuteRequest(req, res);
  });
}

function formatPaseoToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (record.structuredContent !== undefined) {
    return record.structuredContent;
  }
  if (!Array.isArray(record.content)) {
    return result;
  }
  const text = record.content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return null;
      }
      const value = (part as Record<string, unknown>).text;
      return typeof value === "string" ? value : null;
    })
    .filter((part): part is string => part !== null)
    .join("\n");
  return text || record.content;
}
