// User-facing copy for the provider-usage surfaces, centralized until this
// feature area moves into the shared i18n resources.
export const providerUsageCopy = {
  title: "Plan usage",
  refresh: "Refresh",
  refreshing: "Refreshing...",
  loading: "Loading usage...",
  empty: "No usage data",
  errorTitle: "Unable to load usage",
  hostUnavailable: "Connect to this host to see provider usage",
  hostUpgradeRequired: "Update the host to see provider usage",
  clientUnavailable: "Host connection is not ready",
  retry: "Try again",
  tooltipLoading: "Loading plan usage…",
  shownProvidersTitle: "Shown providers",
  allHidden: "All providers are hidden",
  updateVisibilityError: "Unable to update shown providers",
  showProvider: (provider: string) => `Show ${provider}`,
} as const;
