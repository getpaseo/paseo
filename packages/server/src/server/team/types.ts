import { z } from "zod";

export const TEAM_LABEL = "pandaos.team";
export const TEAM_ROLE_LABEL = "pandaos.team.role";
export const TEAM_ITEM_LABEL = "pandaos.team.item";
export const TEAM_DECISION_LABEL = "pandaos.team.decision";

// Patterns (revisioned items, board phase kinds, seats, decision outbox, health findings) are
// adapted from mastra-ai/mastra mastracode/factory, Apache-2.0. Modified for PandaOS.

export const ActorSchema = z.object({
  type: z.enum(["human", "boss", "runtime", "role"]),
  id: z.string(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const ArtifactSchema = z.object({
  kind: z.enum(["branch", "commit", "pr", "screenshot", "test-run", "document", "other"]),
  ref: z.string(),
  note: z.string().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const CriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  met: z.boolean().optional(),
  evidence: z.string().optional(),
});

export const WorkItemSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  packId: z.string(),
  packVersion: z.number().int(),
  board: z.string(),
  parentId: z.string().optional(),
  title: z.string(),
  objective: z.string(),
  phase: z.string(),
  phaseHistory: z.array(
    z.object({
      phase: z.string(),
      enteredAt: z.string(),
      exitedAt: z.string().optional(),
      by: ActorSchema,
    }),
  ),
  revision: z.number().int(),
  dependsOn: z.array(z.object({ id: z.string(), until: z.string() })),
  conflictsWith: z.array(z.string()),
  exclusive: z.boolean().optional(),
  acceptanceCriteria: z.array(CriterionSchema),
  artifacts: z.array(ArtifactSchema),
  reports: z.array(
    z.object({ role: z.string(), phase: z.string(), outcome: z.string(), summary: z.string() }),
  ),
  returns: z.number().int(),
  bindings: z.record(z.string(), z.string()),
  pack: z.record(z.string(), z.unknown()),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const BindingSchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  role: z.string(),
  phase: z.string(),
  revisionAtStart: z.number().int(),
  decisionId: z.string(),
  agentId: z.string(),
  profile: z.string(),
  status: z.enum(["active", "revoked"]),
  turn: z.enum(["starting", "running", "idle", "reported"]),
  nudges: z.number().int(),
  errors: z.number().int().default(0),
  lastEventAt: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().optional(),
});
export type Binding = z.infer<typeof BindingSchema>;

export const DecisionKindSchema = z.enum([
  "start-role",
  "message-role",
  "notify-human",
  "invoke-pack-action",
]);

export const DecisionSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  workItemId: z.string(),
  kind: DecisionKindSchema,
  payload: z.record(z.string(), z.unknown()),
  // Phase the decision was made for; a later transition supersedes it.
  phase: z.string(),
  status: z.enum(["pending", "leased", "succeeded", "retry", "failed", "superseded", "proposed"]),
  attempts: z.number().int(),
  availableAt: z.string(),
  leaseExpiresAt: z.string().optional(),
  lastError: z.string().optional(),
  createdAt: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const TeamSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  cwd: z.string(),
  /** Branch the team's worktrees start from. */
  baseBranch: z.string().optional(),
  bossAgentId: z.string(),
  packId: z.string(),
  packVersion: z.number().int(),
  rootItemId: z.string(),
  status: z.enum(["active", "paused", "done", "canceled"]),
  pausedReason: z.string().optional(),
  roleProfiles: z.record(
    z.string(),
    z.object({
      provider: z.string(),
      model: z.string().optional(),
      thinking: z.string().optional(),
      mode: z.string().optional(),
    }),
  ),
  createdAt: z.string(),
});
export type Team = z.infer<typeof TeamSchema>;

export const TeamStateSchema = z.object({
  commit: z.number().int(),
  team: TeamSchema,
  items: z.record(z.string(), WorkItemSchema),
  bindings: z.record(z.string(), BindingSchema),
  decisions: z.record(z.string(), DecisionSchema),
});
export type TeamState = z.infer<typeof TeamStateSchema>;

export const TeamEventSchema = z.object({
  commit: z.number().int(),
  at: z.string(),
  type: z.string(),
  actor: ActorSchema,
  workItemId: z.string().optional(),
  text: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type TeamEvent = z.infer<typeof TeamEventSchema>;

export const TeamReportPayloadSchema = z.object({
  outcome: z.string().min(1),
  summary: z.string().min(1),
  artifacts: z.array(ArtifactSchema).optional(),
  criteria: z
    .array(z.object({ id: z.string(), met: z.boolean(), evidence: z.string() }))
    .optional(),
  needs: z.object({ kind: z.enum(["human", "research", "split"]), text: z.string() }).optional(),
});
export type TeamReportPayload = z.infer<typeof TeamReportPayloadSchema>;

export const PlannedItemSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string()).optional(),
  conflictsWith: z.array(z.string()).optional(),
  exclusive: z.boolean().optional(),
});
export type PlannedItem = z.infer<typeof PlannedItemSchema>;
