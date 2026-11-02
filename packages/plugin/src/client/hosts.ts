import type { PluginHostSummary } from "./index.js";

export type PluginHostStatus = PluginHostSummary["status"];
export type PluginHostColor =
  | "none"
  | "violet"
  | "sky"
  | "emerald"
  | "orange"
  | "pink"
  | "indigo"
  | "teal"
  | "red"
  | "amber"
  | "blue";
export type PluginHostBadgeDisplay = "name" | "icon" | "hidden";
export interface PluginHostAppearance {
  readonly color: PluginHostColor;
  /** Null uses the automatic local or remote default. */
  readonly badgeDisplay: PluginHostBadgeDisplay | null;
}
/** Saved connection settings without credentials. Routed connections have no URI. */
export type PluginHostConnection =
  | {
      readonly id: string;
      readonly type: "directTcp";
      readonly uri: string;
      readonly endpoint: string;
      readonly useTls: boolean;
    }
  | {
      readonly id: string;
      readonly type: "directSocket";
      readonly uri: string;
      readonly path: string;
    }
  | {
      readonly id: string;
      readonly type: "directPipe";
      readonly uri: string;
      readonly path: string;
    }
  | {
      readonly id: string;
      readonly type: "remoteSsh";
      readonly uri: string;
      readonly host: string;
      readonly sshPort?: number;
      readonly daemonPort?: number;
    }
  | {
      readonly id: string;
      readonly type: "relay";
      readonly uri: string;
      readonly relayEndpoint: string;
      readonly useTls: boolean;
      readonly daemonPublicKeyB64: string;
      readonly minimumSecurityMode?: "protected";
    }
  | {
      readonly id: string;
      readonly type: "routed";
      readonly uri: null;
      readonly originServerId: string;
    };
export interface PluginHostPatch {
  label?: string;
  appearance?: Partial<PluginHostAppearance>;
}
export interface PluginHost extends PluginHostSummary {
  readonly appearance: PluginHostAppearance;
  readonly connections: readonly PluginHostConnection[];
  readonly activeConnectionId: string | null;
  readonly error: string | null;
  readonly authFailureReason: "password_required" | "incorrect_password" | null;
  readonly lastOnlineAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  update(patch: PluginHostPatch): Promise<void>;
  /** Removes the host; throws for the desktop daemon host. */
  remove(): Promise<void>;
  /** Removing the last connection removes the host. */
  removeConnection(connectionId: string): Promise<void>;
  openSettings(): void;
}
export interface PluginHostAddInput {
  /** Shared host connection grammar; may contain a password for the probe. */
  connection: string;
  label?: string;
}
export type PluginHostAddResult =
  | { status: "saved"; host: PluginHost }
  | { status: "password_required"; reason: "password_required" | "incorrect_password" }
  | { status: "cancelled" };
export declare function useHosts(): readonly PluginHost[];
export declare function observeHosts(listener: (hosts: readonly PluginHost[]) => void): () => void;

export declare function addHost(input: PluginHostAddInput): Promise<PluginHostAddResult>;
