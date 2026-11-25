import { useMemo } from "react";
import { getIsElectronRuntime } from "@/constants/layout";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHosts, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import { orderHostsLocalFirst } from "@/types/host-connection";
import type { AddProjectHost } from "./model";

/** Every host, whether it is online, and what each can do in Add project, the local host first. */
export function useAddProjectHosts(): AddProjectHost[] {
  const hosts = useHosts();
  const hostIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(hostIds);
  const projectAddByHost = useHostFeatureMap(hostIds, "projectAdd");
  // COMPAT(stableProjectIdentity): added in v0.1.109, remove gate after 2027-01-15.
  const stableProjectIdentityByHost = useHostFeatureMap(hostIds, "stableProjectIdentity");
  // COMPAT(projectGithubClone): added in v0.1.108, remove gate after 2027-01-15.
  const githubCloneByHost = useHostFeatureMap(hostIds, "projectGithubClone");
  // COMPAT(workspaceGithubRepositorySearch): added in v0.1.108, remove gate after 2027-01-15.
  const githubSearchByHost = useHostFeatureMap(hostIds, "workspaceGithubRepositorySearch");
  // COMPAT(projectCreateDirectory): added in v0.1.108, remove gate after 2027-01-15.
  const createDirectoryByHost = useHostFeatureMap(hostIds, "projectCreateDirectory");
  const localServerId = useLocalDaemonServerId();

  return useMemo<AddProjectHost[]>(() => {
    return orderHostsLocalFirst(hosts, localServerId).map((host) => {
      const canAddProject =
        projectAddByHost.get(host.serverId) === true &&
        stableProjectIdentityByHost.get(host.serverId) === true;
      return {
        serverId: host.serverId,
        label: host.label,
        online: connectionStatuses.get(host.serverId) === "online",
        canAddProject,
        canBrowse: canAddProject && getIsElectronRuntime() && localServerId === host.serverId,
        canCloneGithubRepositories: githubCloneByHost.get(host.serverId) === true,
        canSearchGithubRepositories: githubSearchByHost.get(host.serverId) === true,
        canCreateDirectory: createDirectoryByHost.get(host.serverId) === true,
      };
    });
  }, [
    connectionStatuses,
    createDirectoryByHost,
    githubCloneByHost,
    githubSearchByHost,
    hosts,
    localServerId,
    projectAddByHost,
    stableProjectIdentityByHost,
  ]);
}
