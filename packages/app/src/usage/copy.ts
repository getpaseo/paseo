// User-facing copy for the usage surfaces, kept in one file so localization is a
// single-file change.
export const usageCopy = {
  title: "Usage",
  planUsage: "Plan usage",
  refresh: "Refresh",
  refreshing: "Refreshing...",
  refreshFailed: "Unable to refresh usage",
  updated: "Updated",
  loading: "Loading usage...",
  empty: "No usage data",
  noHosts: "No connected hosts",
  errorTitle: "Unable to load usage",
  hostUnavailable: (host: string) => `Connect to ${host} to see usage`,
  hostUpgradeRequired: (host: string) => `Update ${host} to see usage`,
  clientUnavailable: "Host connection is not ready",
  retry: "Try again",
  pin: "Pin",
  displayUsed: "Used",
  displayRemaining: "Remaining",
} as const;
