import { z } from "zod";

export const PROVIDER_ACCOUNT_PROVIDERS = ["codex", "claude"] as const;

export const ProviderAccountProviderSchema = z.enum(PROVIDER_ACCOUNT_PROVIDERS);

export type ProviderAccountProvider = z.infer<typeof ProviderAccountProviderSchema>;

export const ProviderAccountIdentitySchema = z
  .object({
    email: z.string().trim().min(1).nullable().optional(),
    organization: z.string().trim().min(1).nullable().optional(),
    plan: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export type ProviderAccountIdentity = z.infer<typeof ProviderAccountIdentitySchema>;

export const ProviderAccountProfileSchema = z
  .object({
    id: z.string().regex(/^pac_[a-f0-9]{16}$/),
    provider: ProviderAccountProviderSchema,
    name: z.string().trim().min(1).max(64),
    identity: ProviderAccountIdentitySchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastAuthenticatedAt: z.string().datetime().nullable(),
  })
  .strict();

export type ProviderAccountProfile = z.infer<typeof ProviderAccountProfileSchema>;

export const ProviderAccountLoginStatusSchema = z.enum([
  "starting",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
]);

export const ProviderAccountLoginSchema = z
  .object({
    accountProfileId: z.string(),
    provider: ProviderAccountProviderSchema,
    status: ProviderAccountLoginStatusSchema,
    loginId: z.string().nullable(),
    verificationUrl: z.string().url().nullable(),
    userCode: z.string().nullable(),
    error: z.string().nullable(),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ProviderAccountLogin = z.infer<typeof ProviderAccountLoginSchema>;

export function normalizeProviderAccountName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function providerAccountNameKey(name: string): string {
  return normalizeProviderAccountName(name).toLowerCase();
}
