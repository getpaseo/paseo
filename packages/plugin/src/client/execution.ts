import type { PaseoAgentConfig, PaseoAgentSendOptions } from "@getpaseo/client";

export interface PluginExecutionPreset {
  id: string;
  title: string;
  description?: string;
  group?: string;
  unavailableReason?: string;
}

export interface PluginExecutionPresetCatalog {
  presets: readonly PluginExecutionPreset[];
  defaultPresetId?: string;
  unavailableReason?: string;
}

export interface PluginExecutionStartInput {
  workspaceId: string;
  cwd: string;
  projectId?: string;
  presetId: string;
  text: string;
  images: NonNullable<PaseoAgentSendOptions["images"]>;
  attachments: NonNullable<PaseoAgentSendOptions["attachments"]>;
  idempotencyKey: string;
  defaultAgentConfig?: PaseoAgentConfig;
  routingMode?: "auto" | "manual";
}

export interface PluginExecutionModeContribution {
  id: string;
  title: string;
  icon: string;
  placeholder?: string;
  onManage?(): void;
  loadPresets(input: { cwd: string; projectId?: string }): Promise<PluginExecutionPresetCatalog>;
  start(input: PluginExecutionStartInput): Promise<{ agentId: string }>;
}

export interface PluginOpenNewWorkspaceOptions {
  executionId: string;
  presetId?: string;
  projectId?: string;
  cwd?: string;
  serverId?: string;
}

export interface PluginOpenSurfaceOptions {
  params?: Readonly<Record<string, string>>;
}
