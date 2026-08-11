import { z } from "zod";

const activationUrlSchema = z.url({ protocol: /^https?$/u });

export const authorizationSchema = z
  .object({
    deviceCode: z.string().min(32),
    userCode: z.string().min(1),
    verificationUri: activationUrlSchema,
    verificationUriComplete: activationUrlSchema,
    expiresAt: z.string().datetime(),
    interval: z.number().int().min(1),
  })
  .strict();

export const authorizationPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), interval: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("slow_down"), interval: z.number().int().min(1) }).strict(),
  z
    .object({
      status: z.literal("authorized"),
      interval: z.number().int().min(1),
      credential: z.string().min(32),
      organizationId: z.string().min(1),
    })
    .strict(),
  z.object({ status: z.literal("denied"), interval: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("expired"), interval: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("disclosed"), interval: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("retry_later") }).strict(),
]);

const projectSchema = z
  .object({ id: z.string().uuid(), slug: z.string().min(1), name: z.string().min(1) })
  .strict();

export const projectsResponseSchema = z.object({ projects: z.array(projectSchema) }).strict();

export const installResponseSchema = z
  .object({
    projectSlug: z.string().min(1),
    version: z.number().int().positive(),
    versionId: z.string().uuid(),
    active: z.literal(true),
  })
  .strict();

export const validationResponseSchema = z
  .object({ projectSlug: z.string().min(1), valid: z.literal(true) })
  .strict();

export const enrollmentTokenSchema = z
  .object({ token: z.string().min(32), expiresAt: z.string().datetime() })
  .strict();

export type CliAuthorization = z.infer<typeof authorizationSchema>;
export type CliAuthorizationPoll = z.infer<typeof authorizationPollSchema>;
export type HubProject = z.infer<typeof projectSchema>;
export type HubInstallResult = z.infer<typeof installResponseSchema>;
export type HubValidationResult = z.infer<typeof validationResponseSchema>;
