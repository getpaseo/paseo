import { z } from "zod";
import type { DesktopCommandHandler } from "../../settings/desktop-settings-commands.js";
import type { BrowserRoutingManager } from "./manager.js";
import type { TunnelInvokeResult } from "./tunnel-bridge.js";

const ServerIdSchema = z.string().trim().min(1).max(512);
const IdSchema = z.string().min(1).max(255);
const PositiveIntSchema = z.number().int().positive();

const RoutingTargetSchema = z.object({ serverId: ServerIdSchema });
const RoutingSetEnabledSchema = z.object({ serverId: ServerIdSchema, enabled: z.boolean() });

const ProviderRegisterSchema = z.object({
  serverId: ServerIdSchema,
  subscriptionId: IdSchema,
  initialWindowBytes: PositiveIntSchema,
  maxDataBytes: PositiveIntSchema,
  maxStreams: PositiveIntSchema,
  connectTimeoutMs: PositiveIntSchema,
});
const ProviderRefSchema = z.object({ serverId: ServerIdSchema, providerId: IdSchema });
const StreamRefSchema = ProviderRefSchema.extend({ streamId: IdSchema });
const StreamDataSchema = StreamRefSchema.extend({ data: z.instanceof(Uint8Array) });
const StreamCreditSchema = StreamRefSchema.extend({ credit: PositiveIntSchema.max(0xffffffff) });
const StreamCloseSchema = StreamRefSchema.extend({ reason: z.number().int().min(0).max(255) });

export interface BrowserRoutingIpcDependencies {
  manager: BrowserRoutingManager;
  /** Only the main app windows may drive routing; guest webviews and popups may not. */
  isTrustedRenderer(senderId: number): boolean;
}

interface InvokeFailure {
  ok: false;
  error: { code: string; message: string };
}

function invalidPayload(issue: string): InvokeFailure {
  return { ok: false, error: { code: "invalid_payload", message: issue } };
}

function untrustedSender(): InvokeFailure {
  return {
    ok: false,
    error: { code: "not_owner", message: "Only the Paseo window may use host network routing." },
  };
}

export function createBrowserRoutingCommandHandlers(
  deps: BrowserRoutingIpcDependencies,
): Record<string, DesktopCommandHandler> {
  const { manager } = deps;

  function guarded<T extends z.ZodType>(
    schema: T,
    run: (senderId: number, input: z.output<T>) => unknown,
  ): DesktopCommandHandler {
    return (args, context) => {
      const senderId = context?.senderId ?? null;
      if (senderId === null || !deps.isTrustedRenderer(senderId)) {
        return untrustedSender();
      }
      manager.noteTrustedRenderer(senderId);
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return invalidPayload(parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      return run(senderId, parsed.data);
    };
  }

  return {
    browser_routing_get_state: guarded(RoutingTargetSchema, async (_senderId, input) => ({
      ok: true,
      enabled: await manager.isEnabled(input.serverId),
    })),
    browser_routing_set_enabled: guarded(RoutingSetEnabledSchema, (_senderId, input) =>
      manager.setEnabled(input.serverId, input.enabled),
    ),
    browser_routing_resolve_partition: guarded(RoutingTargetSchema, (_senderId, input) =>
      manager.resolvePartition(input.serverId),
    ),
    network_tunnel_provider_register: guarded(
      ProviderRegisterSchema,
      (senderId, input): TunnelInvokeResult<{ providerId: string }> =>
        manager.bridge.register(senderId, input),
    ),
    network_tunnel_provider_unregister: guarded(
      ProviderRefSchema,
      (senderId, input): TunnelInvokeResult => manager.bridge.unregister(senderId, input),
    ),
    network_tunnel_stream_connected: guarded(
      StreamRefSchema,
      (senderId, input): TunnelInvokeResult => manager.bridge.streamConnected(senderId, input),
    ),
    network_tunnel_stream_data: guarded(
      StreamDataSchema,
      (senderId, input): TunnelInvokeResult =>
        manager.bridge.streamData(senderId, input, input.data),
    ),
    network_tunnel_stream_credit: guarded(
      StreamCreditSchema,
      (senderId, input): TunnelInvokeResult =>
        manager.bridge.streamCredit(senderId, input, input.credit),
    ),
    network_tunnel_stream_close: guarded(
      StreamCloseSchema,
      (senderId, input): TunnelInvokeResult =>
        manager.bridge.streamClose(senderId, input, input.reason),
    ),
  };
}
