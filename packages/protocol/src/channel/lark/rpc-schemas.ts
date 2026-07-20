import { z } from "zod";
import {
  LarkChannelDomainSchema,
  LarkChannelStatusSchema,
  LarkChannelTargetSchema,
} from "./types.js";

export const LarkChannelGetStatusRequestSchema = z.object({
  type: z.literal("channel.lark.get_status.request"),
  requestId: z.string(),
});

export const LarkChannelGetStatusResponseSchema = z.object({
  type: z.literal("channel.lark.get_status.response"),
  payload: z.object({
    requestId: z.string(),
    status: LarkChannelStatusSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LarkChannelConfigureRequestSchema = z.object({
  type: z.literal("channel.lark.configure.request"),
  requestId: z.string(),
  botId: z.string().min(1).optional(),
  name: z.string().optional(),
  createNew: z.boolean().optional(),
  appId: z.string().min(1).optional(),
  appSecret: z.string().min(1).optional(),
  encryptKey: z.string().min(1).optional(),
  verificationToken: z.string().min(1).optional(),
  clearEncryptKey: z.boolean().optional(),
  clearVerificationToken: z.boolean().optional(),
  domain: LarkChannelDomainSchema.optional(),
  target: LarkChannelTargetSchema.optional(),
});

export const LarkChannelConfigureResponseSchema = z.object({
  type: z.literal("channel.lark.configure.response"),
  payload: z.object({
    requestId: z.string(),
    status: LarkChannelStatusSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LarkChannelTestConnectionRequestSchema = z.object({
  type: z.literal("channel.lark.test_connection.request"),
  requestId: z.string(),
  botId: z.string().min(1).optional(),
});

export const LarkChannelTestConnectionResponseSchema = z.object({
  type: z.literal("channel.lark.test_connection.response"),
  payload: z.object({
    requestId: z.string(),
    status: LarkChannelStatusSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LarkChannelSetEnabledRequestSchema = z.object({
  type: z.literal("channel.lark.set_enabled.request"),
  requestId: z.string(),
  botId: z.string().min(1).optional(),
  enabled: z.boolean(),
});

export const LarkChannelSetEnabledResponseSchema = z.object({
  type: z.literal("channel.lark.set_enabled.response"),
  payload: z.object({
    requestId: z.string(),
    status: LarkChannelStatusSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LarkChannelApprovePairingRequestSchema = z.object({
  type: z.literal("channel.lark.approve_pairing.request"),
  requestId: z.string(),
  botId: z.string().min(1).optional(),
  code: z.string().min(1),
});

export const LarkChannelApprovePairingResponseSchema = z.object({
  type: z.literal("channel.lark.approve_pairing.response"),
  payload: z.object({
    requestId: z.string(),
    status: LarkChannelStatusSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LarkChannelRejectPairingRequestSchema = z.object({
  type: z.literal("channel.lark.reject_pairing.request"),
  requestId: z.string(),
  botId: z.string().min(1).optional(),
  code: z.string().min(1),
});

export const LarkChannelRejectPairingResponseSchema = z.object({
  type: z.literal("channel.lark.reject_pairing.response"),
  payload: z.object({
    requestId: z.string(),
    status: LarkChannelStatusSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LarkChannelRevokeUserRequestSchema = z.object({
  type: z.literal("channel.lark.revoke_user.request"),
  requestId: z.string(),
  botId: z.string().min(1).optional(),
  userId: z.string().min(1),
});

export const LarkChannelRevokeUserResponseSchema = z.object({
  type: z.literal("channel.lark.revoke_user.response"),
  payload: z.object({
    requestId: z.string(),
    status: LarkChannelStatusSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LarkChannelDeleteBotRequestSchema = z.object({
  type: z.literal("channel.lark.delete_bot.request"),
  requestId: z.string(),
  botId: z.string().min(1),
});

export const LarkChannelDeleteBotResponseSchema = z.object({
  type: z.literal("channel.lark.delete_bot.response"),
  payload: z.object({
    requestId: z.string(),
    status: LarkChannelStatusSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LarkChannelStatusChangedMessageSchema = z.object({
  type: z.literal("channel.lark.status_changed"),
  payload: z.object({
    status: LarkChannelStatusSchema,
  }),
});
