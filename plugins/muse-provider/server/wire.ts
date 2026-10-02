import { z } from "zod";

export const fingerprint =
  "sha256:e0e163db6ccf00dbe68402ce55d6319b3edc33c421f31e9583b587b2de8a118f";
export const effortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export const approvalModeSchema = z.enum([
  "onRequest",
  "promptUnmatched",
  "denyUnmatched",
  "allowAll",
]);
export const itemSchema = z.object({
  itemId: z.string(),
  revision: z.number().int(),
  childSessionId: z.string().optional(),
  role: z.string().optional(),
  objective: z.string().optional(),
  message: z.string().default(""),
  entryId: z.string().optional(),
  kind: z.string(),
  status: z.string(),
  turnId: z.string().nullable().optional(),
  commandId: z.string().optional(),
  recordedAt: z.string().optional(),
  text: z.string().default(""),
  displayText: z.string().optional(),
  summary: z.array(z.string()).default([]),
  tool: z.string().default(""),
  args: z.string().default("{}"),
  callId: z.string().optional(),
  commandText: z.string().optional(),
  visibleOutput: z.string().default(""),
  exitCode: z.number().optional(),
  fallbackText: z.string().default(""),
  failureReason: z.string().optional(),
  patchRef: z.object({ id: z.string() }).optional(),
  tokensBefore: z.number().optional(),
});
export type WireItem = z.infer<typeof itemSchema>;
export const requirementSchema = z.object({
  approvalId: z.string(),
  sourceIndex: z.number().optional(),
});
export const choiceSchema = z.object({
  choiceId: z.string(),
  decision: z.string(),
  label: z.string(),
  scope: z.string(),
});
export const approvalSchema = z.object({
  approvalId: z.string(),
  currentRequirementId: requirementSchema.optional(),
  availableChoices: z.array(choiceSchema),
  toolName: z.string().default("Tool"),
  subject: z.object({
    kind: z.string(),
    command: z.string().default(""),
    path: z.string().default(""),
    host: z.string().default(""),
    workspaceRoot: z.string().optional(),
    stages: z
      .array(
        z.object({
          position: z.number(),
          totalStages: z.number(),
          argv: z.array(z.string()),
          requirementId: requirementSchema,
          resolution: z.object({ kind: z.string() }),
        }),
      )
      .default([]),
  }),
});
export type WireApproval = z.infer<typeof approvalSchema>;
export const notificationSchema = z.object({
  sessionId: z.string().optional(),
  viewCursor: z.string().optional(),
});
export const frameSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z
        .object({ kind: z.string().optional(), reason: z.string().optional() })
        .passthrough()
        .optional(),
    })
    .optional(),
});
export const initializedSchema = z.object({ schema: z.object({ fingerprint: z.string() }) });
export const accountSchema = z.object({
  state: z.string(),
});
export const catalogSchema = z.object({
  models: z.array(
    z.object({
      modelId: z.string(),
      providerId: z.string(),
      displayLabel: z.string(),
      contextLimit: z.number().nullable(),
      isDefault: z.boolean(),
      defaultReasoningEffort: effortSchema.nullable().optional(),
      reasoningEffortVariants: z.union([z.array(effortSchema), z.literal("unknown")]).default([]),
      variants: z.array(effortSchema).default([]),
    }),
  ),
});
export const sessionSchema = z.object({
  session: z.object({
    sessionId: z.string(),
    modelId: z.string(),
    providerId: z.string(),
    approvalMode: z.object({ mode: approvalModeSchema }).optional(),
  }),
  viewCursor: z.string(),
  history: z
    .object({ mode: z.string(), items: z.array(itemSchema).nullable().default([]) })
    .optional(),
  pendingRequests: z
    .array(
      z.object({ kind: z.string(), approvalId: z.string().optional(), viewCursor: z.string() }),
    )
    .default([]),
});
export const persistenceSchema = z.object({
  sessionId: z.string(),
  cursor: z.string().optional(),
  model: z.string().optional(),
  thinkingOption: effortSchema.optional(),
});
export const deltaSchema = z.object({ itemId: z.string(), field: z.string(), delta: z.string() });
export const turnSchema = z.object({
  turnId: z.string(),
  commandId: z.string().optional(),
  terminal: z.string().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
});
export const promptResultSchema = z.object({ turnId: z.string(), disposition: z.string() });
export const outputSchema = z.object({
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  eof: z.boolean(),
});
export const patchSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      hunks: z.array(
        z.object({
          oldStart: z.number(),
          oldLines: z.number(),
          newStart: z.number(),
          newLines: z.number(),
          lines: z.array(z.string()),
        }),
      ),
    }),
  ),
});
export const toolArgsSchema = z.object({
  objective: z.string().optional(),
  role: z.string().optional(),
  command: z.string().default(""),
  path: z.string().default(""),
  find: z.string().optional(),
  replace: z.string().optional(),
  content: z.string().optional(),
  query: z.string().default(""),
  pattern: z.string().default(""),
  url: z.string().default(""),
});
export const tokenUsageSchema = z.object({
  cumulative: z.object({ promptTokens: z.number(), outputTokens: z.number() }),
  usage: z.object({ cachedTokens: z.number().optional() }).optional(),
});
export const contextUsageSchema = z.object({
  usedTokens: z.number(),
  windowTokens: z.number().optional(),
});

export const ackSchema = z.object({}).passthrough();
export const skillsSchema = z.object({
  skills: z.array(
    z.object({
      selector: z.string(),
      description: z.string(),
      argumentHint: z.string().optional(),
    }),
  ),
});
export const questionSchema = z.object({
  userInputId: z.string(),
  toolName: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string().default("") })),
      selection: z.object({
        mode: z.enum(["single", "multiple"]),
        minSelections: z.number().optional(),
        maxSelections: z.number().optional(),
      }),
    }),
  ),
});
export const settledQuestionSchema = z.object({ userInputId: z.string() });
export const questionAnswersSchema = z.object({ answers: z.record(z.string(), z.string()) });
export const todoSchema = z.object({
  viewCursor: z.string(),
  items: z.array(
    z.object({ text: z.string(), status: z.string(), activeForm: z.string().optional() }),
  ),
});
export const pageSchema = z.object({
  events: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.unknown()) })),
  nextCursor: z.string().nullable(),
});
export const gapSchema = z.object({ after: z.string(), next: z.string() });
export const sessionListSchema = z.object({
  nextCursor: z.string().nullable(),
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      workspaceRoot: z.string().nullable(),
      title: z.string().optional(),
      updatedAt: z.string(),
      modelId: z.string(),
    }),
  ),
});
export const usageSchema = z.object({
  usage: z
    .object({
      observedAtMs: z.number(),
      tier: z.string(),
      window: z.object({
        resetsAtMs: z.number(),
        usedPercent: z.number(),
        windowDurationMins: z.number(),
      }),
      weekly: z.object({ resetsAtMs: z.number(), usedPercent: z.number() }),
    })
    .optional(),
});
export const childSessionSchema = z.object({
  session: z.object({
    sessionId: z.string(),
    workspaceRoot: z.string().nullable(),
    title: z.string().optional(),
  }),
  viewCursor: z.string(),
});

export const itemNotificationSchema = z.object({ item: itemSchema });

export const pendingSchema = z.object({
  approvals: z.array(approvalSchema),
  userInputs: z.array(questionSchema).default([]),
});

export const approvalResolvedSchema = z.object({ approvalId: z.string() });
