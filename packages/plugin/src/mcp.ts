import { z } from "zod";

/** Private service configuration. Never send it to a contributed client surface. */
export const PluginMcpConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      url: z.url({ protocol: /^https?$/ }),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("sse"),
      url: z.url({ protocol: /^https?$/ }),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);
export type PluginMcpConfig = z.infer<typeof PluginMcpConfigSchema>;
export const PluginMcpServerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    settingsScreenId: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    config: PluginMcpConfigSchema.nullable(),
  })
  .strict();
export type PluginMcpServer = z.infer<typeof PluginMcpServerSchema>;
export interface PluginMcpRegistration {
  update(config: PluginMcpConfig | null): void;
  remove(): void;
}
