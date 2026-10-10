import type { NetworkTunnel } from "@getpaseo/client";
import { z } from "zod";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { listenToDesktopEvent } from "@/desktop/electron/events";

export const ROUTED_BROWSER_PARTITION_PREFIX = "persist:paseo-browser-via-";

export type NetworkTunnelOpener = () => Promise<NetworkTunnel>;
export interface RoutingDesktop {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}
export const routingDesktop: RoutingDesktop = {
  invoke: invokeDesktopCommand,
  listen: listenToDesktopEvent,
};
export const ipcFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});
export const ipcAckSchema = z.union([z.object({ ok: z.literal(true) }), ipcFailureSchema]);
export const routingChangedSchema = z.object({ serverId: z.string().min(1), enabled: z.boolean() });
export class RoutingIpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireIpcSuccess<T extends { ok: true }>(
  result: T | z.infer<typeof ipcFailureSchema>,
): T {
  if (!result.ok) throw new RoutingIpcError(result.error.code, result.error.message);
  return result;
}
export async function getBrowserRoutingState(
  serverId: string,
  desktop = routingDesktop,
): Promise<boolean> {
  const result = z
    .union([z.object({ ok: z.literal(true), enabled: z.boolean() }), ipcFailureSchema])
    .parse(await desktop.invoke("browser_routing_get_state", { serverId }));
  return requireIpcSuccess(result).enabled;
}
export async function resolveBrowserPartition(
  serverId: string,
  sharedPartition: string,
  desktop = routingDesktop,
): Promise<string> {
  const result = z
    .union([
      z.object({
        ok: z.literal(true),
        partition: z.string().startsWith(ROUTED_BROWSER_PARTITION_PREFIX),
      }),
      ipcFailureSchema,
    ])
    .parse(await desktop.invoke("browser_routing_resolve_partition", { serverId }));
  if (!result.ok && result.error.code === "routing_disabled") return sharedPartition;
  return requireIpcSuccess(result).partition;
}
// COMPAT(networkTunnel): added in v0.12.0, remove after 2027-10-08.
export function supportsNetworkTunnel(
  features: { networkTunnel?: boolean } | null | undefined,
): boolean {
  return features?.networkTunnel === true;
}
export function getRoutingOptionAvailability(input: {
  isElectron: boolean;
  isLocal: boolean;
  supported: boolean;
}) {
  return { visible: input.isElectron && !input.isLocal, available: input.supported };
}
