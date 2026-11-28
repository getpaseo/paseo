import { z } from "zod";
import {
  AgentSnapshotPayloadSchema,
  ProjectCheckoutLiteGitNonPaseoPayloadSchema,
  ProjectCheckoutLiteGitPaseoPayloadSchema,
  ProjectCheckoutLiteNotGitPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WorkspaceDescriptorPayloadSchema,
  WSHelloRejectedMessageSchema,
  WSPongMessageSchema,
} from "../messages.js";

export const sessionOutboundMessageOptions = SessionOutboundMessageSchema.options;
export const sessionInboundMessageOptions = SessionInboundMessageSchema.options;
export const helloRejectedReasons = WSHelloRejectedMessageSchema.shape.reason.options;
export const agentSnapshotPayloadSchema = AgentSnapshotPayloadSchema;

// Legacy `.transform()` schemas whose wire defaults cannot be seen as `.default()` nodes alone.
// Keyed by schema identity so every message referencing them automatically inherits these rules.
export const legacySchemaTransformDefaults = new Map<unknown, Record<string, unknown>>([
  [ProjectCheckoutLiteNotGitPayloadSchema, { worktreeRoot: { k: "d", v: null } }],
  [ProjectCheckoutLiteGitNonPaseoPayloadSchema, { worktreeRoot: { k: "f", from: "cwd" } }],
  [ProjectCheckoutLiteGitPaseoPayloadSchema, { worktreeRoot: { k: "f", from: "cwd" } }],
  [
    WorkspaceDescriptorPayloadSchema,
    {
      statusEnteredAt: { k: "d", v: null },
      workspaceDirectory: { k: "f", from: "projectRootPath" },
    },
  ],
]);

const [firstSessionTag, ...otherSessionTags] = sessionOutboundMessageOptions.map((option) =>
  z.object({ type: option.shape.type }),
);

// WSOutboundMessageSchema with every session message reduced to its tag. It reports the same
// envelope and discriminator issues, while each session message gets its own generated validator:
// one function for the whole protocol is large enough that V8's Maglev tier spends hundreds of MB
// and seconds compiling it.
export const WSOutboundEnvelopeSchema = z.discriminatedUnion("type", [
  WSPongMessageSchema,
  z.object({
    type: z.literal("session"),
    message: z.discriminatedUnion("type", [firstSessionTag, ...otherSessionTags]),
  }),
  WSHelloRejectedMessageSchema,
]);
