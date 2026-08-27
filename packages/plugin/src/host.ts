import { PluginAttachmentSearchPayloadSchema } from "./attachments.js";
export { PluginClientStateProvider, type PluginClientStateSource } from "./client-state.js";
import type {
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginContext,
  PluginNotificationSourceContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginSurfaceProps,
  PluginThemeContribution,
  PluginWorkspacePanelContribution,
} from "./contracts.js";
import {
  PluginNotificationPollResultSchema,
  readPluginNotificationSource,
  resolvePluginNotificationInterval,
} from "./notifications.js";
import { PluginRpcProvider } from "./rpc-context.js";
import { PaseoApiProvider } from "./paseo-context.js";
import { callPluginRpc } from "./rpc.js";
import type { ComponentType } from "react";

interface PluginCollector {
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
  addSidebarItem(contribution: PluginSidebarContribution): void;
  addWorkspacePanel(contribution: PluginWorkspacePanelContribution): void;
  addCommandCenterItem(contribution: PluginCommandCenterItemContribution): void;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution): void;
  addNotificationSource(contribution: PluginNotificationSourceContribution): void;
  addTheme(contribution: PluginThemeContribution): void;
}

export interface PluginRegistrationCollector {
  surfaces: PluginSurfaceContribution[];
  sidebarItems: PluginSidebarContribution[];
  workspacePanels: PluginWorkspacePanelContribution[];
  commandCenterItems: PluginCommandCenterItemContribution[];
  attachmentSources: PluginAttachmentSourceContribution[];
  notificationSources: PluginNotificationSourceContribution[];
  themes: PluginThemeContribution[];
}

export function createPluginContext(
  collector: PluginCollector,
): Pick<
  PluginContext,
  | "addSurface"
  | "addSidebarItem"
  | "addWorkspacePanel"
  | "addCommandCenterItem"
  | "addAttachmentSource"
  | "addNotificationSource"
  | "addTheme"
> {
  return {
    addSurface(id, Component) {
      collector.addSurface(id, Component);
    },
    addSidebarItem(contribution) {
      collector.addSidebarItem(contribution);
    },
    addWorkspacePanel(contribution) {
      collector.addWorkspacePanel(contribution);
    },
    addCommandCenterItem(contribution) {
      collector.addCommandCenterItem(contribution);
    },
    addAttachmentSource(contribution) {
      collector.addAttachmentSource(contribution);
    },
    addNotificationSource(contribution) {
      collector.addNotificationSource(contribution);
    },
    addTheme(contribution) {
      collector.addTheme(contribution);
    },
  };
}

export async function searchPluginAttachments(
  source: PluginAttachmentSourceContribution,
  invoke: (method: string, input: unknown) => Promise<unknown>,
  query: string,
) {
  const output = await callPluginRpc(source.search, invoke, { query });
  return PluginAttachmentSearchPayloadSchema.parseAsync(output);
}

export {
  callPluginRpc,
  PaseoApiProvider,
  PluginNotificationPollResultSchema,
  PluginRpcProvider,
  readPluginNotificationSource,
  resolvePluginNotificationInterval,
};
