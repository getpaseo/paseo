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

/** Port `ssh` itself uses when neither Paseo nor `~/.ssh/config` names one. */
export const DEFAULT_SSH_PORT = 22;
/** Port the remote daemon listens on, and the far end of the tunnel. */
export const DEFAULT_SSH_REMOTE_PORT = 6767;

export const SshHostConnectionSchema = z.object({
  id: z.string(),
  type: z.literal("ssh"),
  host: z.string(),
  // Deliberately *not* defaulted. "Unset" has to stay distinguishable from
  // "22" so the CLI can omit `-p` and let a `Port` directive in the user's
  // ~/.ssh/config win. Display code falls back to DEFAULT_SSH_PORT.
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().optional(),
  remotePort: z.number().int().min(1).max(65535).optional().default(DEFAULT_SSH_REMOTE_PORT),
  remoteHome: z.string().optional().default("~/.paseo"),
  installDir: z.string().optional().default("~/.paseo/cli"),
});

export type SshHostConnection = z.input<typeof SshHostConnectionSchema>;
export type NormalizedSshHostConnection = z.output<typeof SshHostConnectionSchema>;

/**
 * Apply defaults to an SSH connection. Fields that are undefined get the
 * schema defaults (remotePort 6767, remoteHome ~/.paseo, installDir
 * ~/.paseo/cli); `port` stays undefined on purpose. Shared by the CLI,
 * desktop, and app so the defaults live in one place — the protocol schema.
 */
export function normalizeSshConnection(
  input: Partial<SshHostConnection> & { id: string; host: string },
): NormalizedSshHostConnection {
  return SshHostConnectionSchema.parse({
    type: "ssh",
    ...input,
  });
}
