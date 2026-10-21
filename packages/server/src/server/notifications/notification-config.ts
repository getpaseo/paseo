import { z } from "zod";

const PrioritySchema = z.enum(["min", "low", "default", "high", "urgent"]);
export const NotificationConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(["legacy", "smart", "always_push"]).default("legacy"),
    provider: z.enum(["expo", "ntfy", "both"]).default("expo"),
    onFinish: z.boolean().default(true),
    onError: z.boolean().optional(),
    onPermission: z.boolean().default(true),
    onTerminal: z.boolean().default(true),
    includePreviews: z.boolean().default(false),
    tokenRetentionDays: z.number().int().min(7).max(3650).default(180),
    ntfy: z
      .object({
        url: z.string().optional(),
        topic: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,64}$/)
          .optional(),
        token: z
          .string()
          .min(1)
          .regex(/^[\x21-\x7e]+$/)
          .optional(),
        allowHttp: z.boolean().default(false),
        priorities: z
          .object({
            finished: PrioritySchema.default("default"),
            error: PrioritySchema.default("high"),
            permission: PrioritySchema.default("urgent"),
            terminal: PrioritySchema.default("default"),
          })
          .default({
            finished: "default",
            error: "high",
            permission: "urgent",
            terminal: "default",
          }),
      })
      .default({
        allowHttp: false,
        priorities: {
          finished: "default",
          error: "high",
          permission: "urgent",
          terminal: "default",
        },
      }),
  })
  .strict();
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

export const NOTIFICATION_ENV_KEYS = [
  "PASEO_NOTIFICATIONS_ENABLED",
  "PASEO_NOTIFICATION_MODE",
  "PASEO_NOTIFICATION_PROVIDER",
  "PASEO_NOTIFY_ON_FINISH",
  "PASEO_NOTIFY_ON_ERROR",
  "PASEO_NOTIFY_ON_PERMISSION",
  "PASEO_NOTIFY_ON_TERMINAL",
  "PASEO_NOTIFICATION_PREVIEWS",
  "PASEO_PUSH_TOKEN_RETENTION_DAYS",
  "PASEO_NTFY_URL",
  "PASEO_NTFY_TOPIC",
  "PASEO_NTFY_TOKEN",
  "PASEO_NTFY_ALLOW_HTTP",
  "PASEO_NTFY_PRIORITY_FINISH",
  "PASEO_NTFY_PRIORITY_ERROR",
  "PASEO_NTFY_PRIORITY_PERMISSION",
  "PASEO_NTFY_PRIORITY_TERMINAL",
] as const;

function booleanEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean | undefined) {
  const value = env[key]?.trim().toLowerCase();
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`Invalid boolean notification setting: ${key}`);
}

export function resolveNotificationConfig(
  env: NodeJS.ProcessEnv,
  persisted?: NotificationConfig,
): NotificationConfig {
  const base = persisted ?? NotificationConfigSchema.parse({});
  const parsed = NotificationConfigSchema.safeParse({
    ...base,
    enabled: booleanEnv(env, "PASEO_NOTIFICATIONS_ENABLED", base.enabled),
    mode: env.PASEO_NOTIFICATION_MODE ?? base.mode,
    provider: env.PASEO_NOTIFICATION_PROVIDER ?? base.provider,
    onFinish: booleanEnv(env, "PASEO_NOTIFY_ON_FINISH", base.onFinish),
    onError: booleanEnv(env, "PASEO_NOTIFY_ON_ERROR", base.onError),
    onPermission: booleanEnv(env, "PASEO_NOTIFY_ON_PERMISSION", base.onPermission),
    onTerminal: booleanEnv(env, "PASEO_NOTIFY_ON_TERMINAL", base.onTerminal),
    includePreviews: booleanEnv(env, "PASEO_NOTIFICATION_PREVIEWS", base.includePreviews),
    tokenRetentionDays:
      env.PASEO_PUSH_TOKEN_RETENTION_DAYS === undefined
        ? base.tokenRetentionDays
        : Number(env.PASEO_PUSH_TOKEN_RETENTION_DAYS),
    ntfy: {
      ...base.ntfy,
      url: env.PASEO_NTFY_URL ?? base.ntfy.url,
      topic: env.PASEO_NTFY_TOPIC ?? base.ntfy.topic,
      token: env.PASEO_NTFY_TOKEN ?? base.ntfy.token,
      allowHttp: booleanEnv(env, "PASEO_NTFY_ALLOW_HTTP", base.ntfy.allowHttp),
      priorities: {
        finished: env.PASEO_NTFY_PRIORITY_FINISH ?? base.ntfy.priorities.finished,
        error: env.PASEO_NTFY_PRIORITY_ERROR ?? base.ntfy.priorities.error,
        permission: env.PASEO_NTFY_PRIORITY_PERMISSION ?? base.ntfy.priorities.permission,
        terminal: env.PASEO_NTFY_PRIORITY_TERMINAL ?? base.ntfy.priorities.terminal,
      },
    },
  });
  if (!parsed.success)
    throw new Error(
      "Invalid notification configuration (check provider, mode, retention and ntfy settings)",
    );
  validateNotificationConfig(parsed.data);
  return parsed.data;
}

export function validateNotificationConfig(config: NotificationConfig): void {
  if (!config.enabled || config.provider === "expo") return;
  if (!config.ntfy.url || !config.ntfy.topic || !config.ntfy.token) {
    throw new Error(
      "ntfy notifications require PASEO_NTFY_URL, PASEO_NTFY_TOPIC and PASEO_NTFY_TOKEN (or daemon.notifications.ntfy settings)",
    );
  }
  let url: URL;
  try {
    url = new URL(config.ntfy.url);
  } catch {
    throw new Error("Invalid ntfy URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && config.ntfy.allowHttp))
  ) {
    throw new Error(
      "ntfy requires HTTPS without URL credentials, query or fragment; trusted HTTP requires explicit allowHttp",
    );
  }
}

export function pushTokenRetentionMs(config?: NotificationConfig): number {
  return (config?.tokenRetentionDays ?? 180) * 24 * 60 * 60 * 1000;
}

export function expoNotificationsEnabled(config?: NotificationConfig): boolean {
  return config === undefined || (config.enabled && config.provider !== "ntfy");
}
