export const RELAY_CONFIG_FIELD_KEYS = [
  "enabled",
  "endpoint",
  "publicEndpoint",
  "useTls",
  "publicUseTls",
] as const;

export type RelayConfigField = (typeof RELAY_CONFIG_FIELD_KEYS)[number];

interface RelayConfigFieldDescriptor {
  mutablePath: `relay.${RelayConfigField}`;
  persistedPath: `daemon.relay.${RelayConfigField}`;
  env: `PASEO_RELAY_${string}`;
  restartRequired: boolean;
}

export const RELAY_CONFIG_FIELDS = {
  enabled: {
    mutablePath: "relay.enabled",
    persistedPath: "daemon.relay.enabled",
    env: "PASEO_RELAY_ENABLED",
    restartRequired: false,
  },
  endpoint: {
    mutablePath: "relay.endpoint",
    persistedPath: "daemon.relay.endpoint",
    env: "PASEO_RELAY_ENDPOINT",
    restartRequired: true,
  },
  publicEndpoint: {
    mutablePath: "relay.publicEndpoint",
    persistedPath: "daemon.relay.publicEndpoint",
    env: "PASEO_RELAY_PUBLIC_ENDPOINT",
    restartRequired: true,
  },
  useTls: {
    mutablePath: "relay.useTls",
    persistedPath: "daemon.relay.useTls",
    env: "PASEO_RELAY_USE_TLS",
    restartRequired: true,
  },
  publicUseTls: {
    mutablePath: "relay.publicUseTls",
    persistedPath: "daemon.relay.publicUseTls",
    env: "PASEO_RELAY_PUBLIC_USE_TLS",
    restartRequired: true,
  },
} as const satisfies Record<RelayConfigField, RelayConfigFieldDescriptor>;
