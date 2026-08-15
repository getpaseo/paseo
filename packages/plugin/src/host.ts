import { PluginAttachmentSearchPayloadSchema } from "./attachments.js";
import type {
  PluginAttachmentSourceContribution,
  PluginContext,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginSurfaceProps,
} from "./contracts.js";
import { PluginRpcProvider } from "./rpc-context.js";
import { callPluginRpc } from "./rpc.js";
import type { ComponentType } from "react";

interface PluginCollector {
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
  addSidebarItem(contribution: PluginSidebarContribution): void;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution): void;
}

export interface PluginRegistrationCollector {
  surfaces: PluginSurfaceContribution[];
  sidebarItems: PluginSidebarContribution[];
  attachmentSources: PluginAttachmentSourceContribution[];
}

export function createPluginContext(
  collector: PluginCollector,
): Pick<PluginContext, "addSurface" | "addSidebarItem" | "addAttachmentSource"> {
  return {
    addSurface(id, Component) {
      collector.addSurface(id, Component);
    },
    addSidebarItem(contribution) {
      collector.addSidebarItem(contribution);
    },
    addAttachmentSource(contribution) {
      collector.addAttachmentSource(contribution);
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

export { callPluginRpc, PluginRpcProvider };
