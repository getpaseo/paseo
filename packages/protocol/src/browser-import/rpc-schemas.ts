import { z } from "zod";

export const BrowserImportLoginSchema = z.object({
  origin: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && url.origin === value;
      } catch {
        return false;
      }
    }),
  username: z.string().max(1024),
  password: z.string().min(1).max(1024),
});

export const BrowserImportSourceSchema = z.object({
  id: z.string().min(1),
  browserName: z.string(),
  profileName: z.string(),
});

export const BrowserImportCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().min(1),
  path: z.string(),

  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});

export const BrowserImportListSourcesRequestSchema = z.object({
  type: z.literal("browser.import.list_sources.request"),
  requestId: z.string(),
});

export const BrowserImportListSourcesResponseSchema = z.object({
  type: z.literal("browser.import.list_sources.response"),
  payload: z.object({
    requestId: z.string(),
    sources: z.array(BrowserImportSourceSchema),
    error: z.string().nullable(),
  }),
});

export const BrowserImportCookiesRequestSchema = z.object({
  type: z.literal("browser.import.import_cookies.request"),
  requestId: z.string(),

  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("host"),
      sourceId: z.string().min(1),
      primaryPassword: z.string().max(1024).optional(),
      includePasswords: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("cookies"),
      cookies: z.array(BrowserImportCookieSchema),
      logins: z.array(BrowserImportLoginSchema).max(100_000).optional(),
    }),
  ]),
});

export const BrowserImportCookiesResponseSchema = z.object({
  type: z.literal("browser.import.import_cookies.response"),
  payload: z.object({
    requestId: z.string(),
    cookieCount: z.number().int().nonnegative(),
    domainCount: z.number().int().nonnegative(),
    passwordCount: z.number().int().nonnegative().optional(),
    skippedPasswords: z.number().int().nonnegative().optional(),
    error: z.string().nullable(),
  }),
});

export type BrowserImportSource = z.infer<typeof BrowserImportSourceSchema>;
export type BrowserImportCookie = z.infer<typeof BrowserImportCookieSchema>;
export type BrowserImportListSourcesRequest = z.infer<typeof BrowserImportListSourcesRequestSchema>;
export type BrowserImportCookiesRequest = z.infer<typeof BrowserImportCookiesRequestSchema>;

export const BrowserProfileBackupRequestSchema = z.object({
  type: z.literal("browser.profile.backup.request"),
  requestId: z.string(),
  action: z.enum(["export", "restore"]),
  passphrase: z.string().min(12).max(1024),
  encrypted: z
    .string()
    .max(32 * 1024 * 1024)
    .optional(),
});
export const BrowserProfileBackupResponseSchema = z.object({
  type: z.literal("browser.profile.backup.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
    encrypted: z.string().optional(),
    cookieCount: z.number().int().nonnegative(),
    passwordCount: z.number().int().nonnegative(),
    skippedCookies: z.number().int().nonnegative(),
    skippedPasswords: z.number().int().nonnegative(),
  }),
});
export type BrowserProfileBackupRequest = z.infer<typeof BrowserProfileBackupRequestSchema>;

export const BrowserProfilePasswordsRequestSchema = z.object({
  type: z.literal("browser.profile.manage_passwords.request"),
  requestId: z.string(),
  action: z.enum(["list", "remove"]),
  origin: z.string().max(2048).optional(),
  username: z.string().max(1024).optional(),
});
export const BrowserProfilePasswordsResponseSchema = z.object({
  type: z.literal("browser.profile.manage_passwords.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
    available: z.boolean(),
    logins: z.array(z.object({ origin: z.string(), username: z.string() })),
  }),
});
export type BrowserProfilePasswordsRequest = z.infer<typeof BrowserProfilePasswordsRequestSchema>;
