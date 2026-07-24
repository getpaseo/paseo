import { z } from "zod";

export const DirectTcpHostConnectionSchema = z.object({
  id: z.string(),
  type: z.literal("directTcp"),
  endpoint: z.string(),
  useTls: z.boolean().optional().default(false),
  password: z.string().optional(),
});

export type DirectTcpHostConnection = z.input<typeof DirectTcpHostConnectionSchema>;
export type NormalizedDirectTcpHostConnection = z.output<typeof DirectTcpHostConnectionSchema>;

export const SshHostConnectionSchema = z.object({
  id: z.string(),
  type: z.literal("ssh"),
  host: z.string(),
  port: z.number().int().min(1).max(65535).optional().default(22),
  user: z.string().optional(),
  remotePort: z.number().int().min(1).max(65535).optional().default(6767),
  remoteHome: z.string().optional().default("~/.paseo"),
  installDir: z.string().optional().default("~/.paseo/cli"),
});

export type SshHostConnection = z.input<typeof SshHostConnectionSchema>;
export type NormalizedSshHostConnection = z.output<typeof SshHostConnectionSchema>;

/**
 * Apply defaults to an SSH connection. Fields that are undefined get the
 * schema defaults (port 22, remotePort 6767, remoteHome ~/.paseo, installDir
 * ~/.paseo/cli). Shared by the CLI, desktop, and app so the defaults live in
 * one place — the protocol schema.
 */
export function normalizeSshConnection(
  input: Partial<SshHostConnection> & { id: string; host: string },
): NormalizedSshHostConnection {
  return SshHostConnectionSchema.parse({
    type: "ssh",
    ...input,
  });
}
