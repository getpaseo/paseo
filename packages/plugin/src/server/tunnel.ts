import type { PaseoApi } from "@getpaseo/client";

export type TunnelStability = "ephemeral" | "stable";

export interface TunnelTarget {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly label?: string;
  readonly slug?: string;
}

export type TunnelProviderStatus =
  | {
      status: "available";
      detail?: string;
    }
  | {
      status: "unavailable";
      reason: string;
      installUrl?: string;
      fixHint?: string;
    };

export type TunnelEvent =
  | { type: "connecting"; detail?: string }
  | { type: "ready"; url: string; stability?: TunnelStability; detail?: string }
  | { type: "reconnecting"; reason?: string }
  | { type: "error"; message: string; recoverable?: boolean }
  | { type: "closed"; reason?: string };

export interface TunnelStatusContext {
  readonly paseo: PaseoApi;
  readonly signal: AbortSignal;
}

export interface TunnelOpenContext {
  readonly paseo: PaseoApi;
  readonly signal: AbortSignal;
  report(event: TunnelEvent): void;
}

export interface TunnelProviderRegistration {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly docsUrl?: string;
  status(context: TunnelStatusContext): Promise<TunnelProviderStatus>;
  open(target: TunnelTarget, context: TunnelOpenContext): Promise<void>;
}
