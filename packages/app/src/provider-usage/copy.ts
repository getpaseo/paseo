// User-facing copy for the provider-usage surfaces, centralized so localization
// is a single-file change. INTEGRATION: move these into the i18n resources
// (a `providerUsage` namespace across all locales) and swap to `t(...)` at the
// call sites once the feature is wired to data. Kept inline for now because the
// surfaces are not yet mounted and the locale files are being edited elsewhere.
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
} as const;
