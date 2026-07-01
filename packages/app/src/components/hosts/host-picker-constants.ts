export const ADD_HOST_OPTION_ID = "__add_host__";
export const ALL_HOSTS_OPTION_ID = "__all_hosts__";

export function getHostPickerLabel(
  hosts: Array<{ label: string; serverId: string }>,
  value: string,
  config?: { includeAllHost?: boolean; includeAddHost?: boolean },
): string {
  if (config?.includeAllHost && value === ALL_HOSTS_OPTION_ID) {
    return "All hosts";
  }
  if (config?.includeAddHost && value === ADD_HOST_OPTION_ID) {
    return "Add host";
  }
  return (
    hosts.find((host) => host.serverId === value)?.label ??
    (config?.includeAllHost ? "All hosts" : "Host")
  );
}
