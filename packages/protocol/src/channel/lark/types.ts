import { z } from "zod";

export const LarkChannelDomainSchema = z.enum(["feishu", "lark"]);
export type LarkChannelDomain = z.infer<typeof LarkChannelDomainSchema>;

export const LarkChannelConnectionStatusSchema = z.enum([
  "disabled",
  "idle",
  "connecting",
  "connected",
  "error",
]);
export type LarkChannelConnectionStatus = z.infer<typeof LarkChannelConnectionStatusSchema>;

const LarkChannelWorkspaceTargetSchema = z.object({
  kind: z.literal("workspace"),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  cwd: z.string().nullable(),
  workspaceId: z.string().nullable(),
});

const LarkChannelAssistantTargetSchema = z.object({
  kind: z.literal("assistant"),
  assistantId: z.string().nullable(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  cwd: z.string().nullable(),
  workspaceId: z.string().nullable(),
});

export const LarkChannelTargetSchema = z.discriminatedUnion("kind", [
  LarkChannelWorkspaceTargetSchema,
  LarkChannelAssistantTargetSchema,
]);
export type LarkChannelTarget = z.infer<typeof LarkChannelTargetSchema>;

export const LarkChannelBotSchema = z.object({
  name: z.string().optional(),
  avatarUrl: z.string().optional(),
});
export type LarkChannelBot = z.infer<typeof LarkChannelBotSchema>;

export const LarkChannelPendingPairingSchema = z.object({
  code: z.string(),
  openId: z.string().nullable(),
  unionId: z.string().nullable(),
  chatId: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type LarkChannelPendingPairing = z.infer<typeof LarkChannelPendingPairingSchema>;

export const LarkChannelAuthorizedUserSchema = z.object({
  id: z.string(),
  openId: z.string().nullable(),
  unionId: z.string().nullable(),
  chatId: z.string(),
  displayName: z.string(),
  authorizedAt: z.string(),
});
export type LarkChannelAuthorizedUser = z.infer<typeof LarkChannelAuthorizedUserSchema>;

export const LarkChannelBotStatusSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  enabled: z.boolean(),
  connectionStatus: LarkChannelConnectionStatusSchema,
  error: z.string().nullable(),
  appId: z.string().nullable(),
  hasAppSecret: z.boolean(),
  hasEncryptKey: z.boolean(),
  hasVerificationToken: z.boolean(),
  domain: LarkChannelDomainSchema,
  target: LarkChannelTargetSchema,
  bot: LarkChannelBotSchema.nullable(),
  pendingPairings: z.array(LarkChannelPendingPairingSchema),
  authorizedUsers: z.array(LarkChannelAuthorizedUserSchema),
});
export type LarkChannelBotStatus = z.infer<typeof LarkChannelBotStatusSchema>;

export const LarkChannelStatusSchema = LarkChannelBotStatusSchema.omit({
  id: true,
  name: true,
}).extend({
  activeBotId: z.string().nullable().default(null),
  bots: z.array(LarkChannelBotStatusSchema).default([]),
});
export type LarkChannelStatus = z.infer<typeof LarkChannelStatusSchema>;
