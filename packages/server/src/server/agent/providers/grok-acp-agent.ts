import type { Logger } from "pino";
import { z } from "zod";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { ACPExtensionNotificationContext } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

// Grok's bundled docs name x.ai/session_notification, but recorded Grok 1.0.5
// auto-compaction traffic uses this extension notification method.
export const GROK_SESSION_UPDATE_METHOD = "_x.ai/session/update";

const GrokCompactionUpdateSchema = z
  .object({
    sessionUpdate: z.string(),
  })
  .passthrough();

const GrokCompactionNotificationSchema = z
  .object({
    sessionId: z.string(),
    update: GrokCompactionUpdateSchema,
  })
  .passthrough();

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

export function mapGrokCompactionExtensionNotification(
  method: string,
  params: Record<string, unknown>,
  context: ACPExtensionNotificationContext,
): AgentTimelineItem[] | null {
  if (method !== GROK_SESSION_UPDATE_METHOD) {
    return null;
  }

  const parsed = GrokCompactionNotificationSchema.safeParse(params);
  if (!parsed.success || parsed.data.sessionId !== context.sessionId) {
    return [];
  }

  const update = parsed.data.update;
  switch (update.sessionUpdate) {
    case "auto_compact_started":
      return [compactionItem("loading")];
    case "auto_compact_completed":
    case "auto_compact_failed":
    case "auto_compact_cancelled":
      return [compactionItem("completed")];
    default:
      return [];
  }
}

function compactionItem(
  status: "loading" | "completed",
): Extract<AgentTimelineItem, { type: "compaction" }> {
  return {
    type: "compaction",
    status,
    trigger: "auto",
  };
}

export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GrokACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId ?? "grok",
      label: options.label ?? "Grok",
      providerParams: options.providerParams,
      extensionNotificationHandler: mapGrokCompactionExtensionNotification,
    });
  }
}
