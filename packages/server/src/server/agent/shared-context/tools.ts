import { z } from "zod";

import { ensureValidJson } from "../../json-utils.js";
import { SHARED_CONTEXT_KINDS, type SharedContextEntry, type SharedContextStore } from "./store.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../tools/types.js";

export interface SharedContextCallerAgent {
  id: string;
  cwd: string;
  title: string | null;
}

export interface RegisterSharedContextToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
      input: any,
      context: PaseoToolExecutionContext,
    ) => Promise<PaseoToolResult>,
  ) => void;
  store: Pick<SharedContextStore, "list" | "save" | "get">;
  resolveProjectIdForCwd: (cwd: string) => Promise<string | null>;
  callerAgentId?: string;
  resolveCallerAgent: () => SharedContextCallerAgent | null;
}

const SharedContextSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(SHARED_CONTEXT_KINDS),
  title: z.string(),
  excerpt: z.string(),
  authorLabel: z.string().nullable(),
  createdAt: z.string(),
});

const SharedContextEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(SHARED_CONTEXT_KINDS),
  title: z.string(),
  body: z.string(),
  authorAgentId: z.string().nullable(),
  authorLabel: z.string().nullable(),
  createdAt: z.string(),
});

const CONTEXT_SAVE_DESCRIPTION =
  "Save durable knowledge to this project's shared context: research findings, codebase learnings, user preferences, or decisions other agents on this project should know. Saved entries are injected into every future agent on the project automatically. Keep entries short and self-contained.";

/**
 * Register the shared project context tools (context_save, context_list,
 * context_read) on the agent tool catalog. Agent-scoped sessions target the
 * caller's cwd; top-level sessions must pass an explicit cwd.
 */
export function registerSharedContextTools(options: RegisterSharedContextToolsOptions): void {
  const resolveTargetProject = async (
    requestedCwd: string | undefined,
  ): Promise<{ projectId: string; cwd: string }> => {
    const callerAgent = options.callerAgentId ? options.resolveCallerAgent() : null;
    const cwd = callerAgent ? callerAgent.cwd : requestedCwd?.trim() || "";
    if (!cwd) {
      throw new Error("cwd is required outside an agent-scoped session");
    }
    const projectId = await options.resolveProjectIdForCwd(cwd);
    if (!projectId) {
      throw new Error(
        `No Paseo project found for ${cwd}. Open the directory as a Paseo workspace before using shared project context tools.`,
      );
    }
    return { projectId, cwd };
  };

  options.registerTool(
    "context_save",
    {
      title: "Save shared project context",
      description: CONTEXT_SAVE_DESCRIPTION,
      inputSchema: {
        kind: z
          .enum(SHARED_CONTEXT_KINDS)
          .optional()
          .describe(
            "Entry kind: research (findings worth keeping), learning (how this codebase works), preference (user's working preferences), note (anything else).",
          ),
        title: z
          .string()
          .trim()
          .min(1, "title is required")
          .describe("Short summary other agents will see first."),
        body: z
          .string()
          .trim()
          .min(1, "body is required")
          .describe("The knowledge itself, self-contained and actionable."),
        cwd: z.string().optional(),
      },
      outputSchema: { entry: SharedContextEntrySchema },
    },
    async ({ kind, title, body, cwd: requestedCwd }) => {
      const { projectId } = await resolveTargetProject(requestedCwd);
      const callerAgent = options.callerAgentId ? options.resolveCallerAgent() : null;
      const entry: SharedContextEntry = await options.store.save(projectId, {
        kind: kind ?? "note",
        title,
        body,
        authorAgentId: callerAgent?.id ?? null,
        authorLabel: callerAgent?.title ?? null,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ entry }),
      };
    },
  );

  options.registerTool(
    "context_list",
    {
      title: "List shared project context",
      description:
        "List this project's shared context entries (newest first), with a short excerpt of each body. Read full entries with context_read.",
      inputSchema: {
        kind: z.enum(SHARED_CONTEXT_KINDS).optional(),
        query: z
          .string()
          .optional()
          .describe("Optional substring filter matched against titles and bodies."),
        cwd: z.string().optional(),
      },
      outputSchema: { entries: z.array(SharedContextSummarySchema) },
    },
    async ({ kind, query, cwd: requestedCwd }) => {
      const { projectId } = await resolveTargetProject(requestedCwd);
      const needle = query?.trim().toLowerCase() ?? null;
      const entries = (await options.store.list(projectId))
        .toReversed()
        .filter((entry) => (kind ? entry.kind === kind : true))
        .filter(
          (entry) =>
            !needle ||
            entry.title.toLowerCase().includes(needle) ||
            entry.body.toLowerCase().includes(needle),
        )
        .map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
          excerpt: entry.body.slice(0, 200),
          authorLabel: entry.authorLabel,
          createdAt: entry.createdAt,
        }));
      return {
        content: [],
        structuredContent: ensureValidJson({ entries }),
      };
    },
  );

  options.registerTool(
    "context_read",
    {
      title: "Read shared project context",
      description:
        "Read full shared context entries by id, as returned by context_list or the injected project context digest.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1, "ids is required"),
        cwd: z.string().optional(),
      },
      outputSchema: { entries: z.array(SharedContextEntrySchema) },
    },
    async ({ ids, cwd: requestedCwd }) => {
      const { projectId } = await resolveTargetProject(requestedCwd);
      const entries = await options.store.get(projectId, ids);
      return {
        content: [],
        structuredContent: ensureValidJson({ entries }),
      };
    },
  );
}
