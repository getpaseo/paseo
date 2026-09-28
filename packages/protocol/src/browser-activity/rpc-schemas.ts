import { z } from "zod";

// Structured action data only: no values, screenshots, or model reasoning cross this boundary.
export const BrowserActivityStepSchema = z.object({
  operation: z.string(),
  target: z.object({ role: z.string(), name: z.string() }).optional(),
  valueSlot: z.string().optional(),
  detail: z.string().optional(),
  confidence: z.number().optional(),
  targetConfidence: z.number().optional(),
  status: z.enum(["pending", "active", "done", "failed"]),
});

export const BrowserActivityPhaseSchema = z.enum([
  "observing",
  "deciding",
  "selected",
  "executing",
  "verifying",
  "paused",
  "finished",
]);

// Every event is the full run state, so a late subscriber needs no history.
export const BrowserActivityEventSchema = z.object({
  runId: z.string(),
  workspaceId: z.string(),
  browserId: z.string(),
  kind: z.enum(["goal", "recipe"]),
  label: z.string(),
  phase: BrowserActivityPhaseSchema,
  step: z.number().int().nonnegative(),
  totalSteps: z.number().int().nonnegative().optional(),
  action: BrowserActivityStepSchema.optional(),
  // Set only when the next step is known exactly; Jev decides after observing again.
  next: BrowserActivityStepSchema.optional(),
  steps: z.array(BrowserActivityStepSchema),
  pauseRequested: z.boolean(),
  result: z
    .object({
      status: z.enum(["passed", "failed"]),
      message: z.string(),
    })
    .optional(),
  updatedAt: z.number(),
});

export const BrowserActivityMessageSchema = z.object({
  type: z.literal("browser.activity"),
  payload: BrowserActivityEventSchema,
});

// The user controls a handed-off tab until they finish or cancel; agent tools on it fail meanwhile.
export const BrowserHandoffSchema = z.object({
  handoffId: z.string(),
  workspaceId: z.string(),
  browserId: z.string(),
  agentId: z.string(),
  reason: z.string(),
  status: z.enum(["active", "done", "cancelled"]),
  updatedAt: z.number(),
});

export const BrowserHandoffMessageSchema = z.object({
  type: z.literal("browser.handoff"),
  payload: BrowserHandoffSchema,
});

export const BrowserActivityControlRequestSchema = z.object({
  type: z.literal("browser.activity.control.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  browserId: z.string().min(1),
  action: z.enum(["pause", "resume", "finish_handoff", "cancel_handoff"]),
});

export const BrowserActivityControlResponseSchema = z.object({
  type: z.literal("browser.activity.control.response"),
  payload: z.object({
    requestId: z.string(),
    workspaceId: z.string(),
    browserId: z.string(),
    // False when no active run or handoff on the browser took the action.
    applied: z.boolean(),
  }),
});

export type BrowserActivityStep = z.infer<typeof BrowserActivityStepSchema>;
export type BrowserActivityPhase = z.infer<typeof BrowserActivityPhaseSchema>;
export type BrowserActivityEvent = z.infer<typeof BrowserActivityEventSchema>;
export type BrowserActivityControlRequest = z.infer<typeof BrowserActivityControlRequestSchema>;
export type BrowserHandoff = z.infer<typeof BrowserHandoffSchema>;

// A daemon tab's actions, replayed by a desktop app in its own local tab instead of
// streaming pixels. Targets are CSS selectors from the daemon's snapshot, with role and
// name as a fallback; a target missing from the local page is skipped.
export const BrowserMirrorTargetSchema = z.object({
  selector: z.string(),
  role: z.string().optional(),
  name: z.string().optional(),
});

export const BrowserMirrorActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string() }),
  z.object({
    kind: z.literal("click"),
    target: BrowserMirrorTargetSchema,
    doubleClick: z.boolean().optional(),
  }),
  // A password field's value never leaves the daemon; the viewer only focuses it.
  z.object({
    kind: z.literal("fill"),
    target: BrowserMirrorTargetSchema,
    value: z.string().optional(),
  }),
  z.object({ kind: z.literal("select"), target: BrowserMirrorTargetSchema, value: z.string() }),
  z.object({
    kind: z.literal("type"),
    target: BrowserMirrorTargetSchema.optional(),
    text: z.string().optional(),
  }),
  z.object({
    kind: z.literal("keypress"),
    target: BrowserMirrorTargetSchema.optional(),
    key: z.string(),
  }),
  z.object({
    kind: z.literal("scroll"),
    target: BrowserMirrorTargetSchema.optional(),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
]);

export const BrowserMirrorEventSchema = z.object({
  workspaceId: z.string(),
  browserId: z.string(),
  action: BrowserMirrorActionSchema,
  at: z.number(),
});

export const BrowserMirrorMessageSchema = z.object({
  type: z.literal("browser.mirror"),
  payload: BrowserMirrorEventSchema,
});

export type BrowserMirrorTarget = z.infer<typeof BrowserMirrorTargetSchema>;
export type BrowserMirrorAction = z.infer<typeof BrowserMirrorActionSchema>;
export type BrowserMirrorEvent = z.infer<typeof BrowserMirrorEventSchema>;
