import { createPluginReferenceApi } from "@getpaseo/plugin/client/host";
import { router } from "expo-router";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { usePanelStore } from "@/stores/panel-store";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { createPluginHosts } from "../hosts";
import type { InstalledPlugin } from "../types";
import { createPluginClientStateSource } from "./source";

interface InstallationApi {
  paseo: ReturnType<typeof createPluginReferenceApi>;
  hosts: ReturnType<typeof createPluginHosts>;
}
// Registry presentation clones share the installation lifetime and its client pool.
const apis = new WeakMap<AbortSignal, InstallationApi>();

export function getPluginClientApi(plugin: InstalledPlugin): InstallationApi {
  const cached = apis.get(plugin.lifetime.signal);
  if (cached) return cached;
  const state = createPluginClientStateSource();
  const hosts = createPluginHosts(getHostRuntimeStore(), plugin.lifetime.signal);
  const paseo = createPluginReferenceApi({
    paseo: plugin.paseo,
    resolveHost: hosts.getPaseoClient,
    readProject: state.getProject,
    navigation: {
      openWorkspace(ref) {
        navigateToWorkspace({ serverId: ref.hostId, workspaceId: ref.id });
      },
      openAgent(ref) {
        const agent = state.getAgent(ref);
        if (!agent) throw new Error(i18n.t("sidebar.view.agentUnavailable"));
        navigateToWorkspace({
          serverId: ref.hostId,
          workspaceId: agent.workspace.id,
          target: { kind: "agent", agentId: ref.id },
        });
      },
      openTerminal(ref) {
        const terminal = state.getTerminal(ref);
        if (!terminal) throw new Error(i18n.t("sidebar.view.terminalUnavailable"));
        navigateToWorkspace({
          serverId: ref.hostId,
          workspaceId: terminal.workspace.id,
          target: { kind: "terminal", terminalId: ref.id },
        });
      },
      openProject(ref) {
        const project = state.getProject(ref);
        if (!project) throw new Error(i18n.t("sidebar.view.projectUnavailable"));
        usePanelStore.getState().showMobileAgent();
        router.push(
          buildNewWorkspaceRoute({
            serverId: ref.hostId,
            projectId: ref.id,
            sourceDirectory: project.rootPath,
            displayName: project.displayName,
          }),
        );
      },
    },
  });
  const api = { paseo, hosts };
  apis.set(plugin.lifetime.signal, api);
  return api;
}
