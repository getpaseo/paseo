import { controlsFromFeatures, optionsFromFeatures } from "@getpaseo/protocol/option-controls";
import type {
  AgentProfile,
  AgentSnapshotPayload,
  MutableDaemonConfig,
  ListProviderFeaturesResponseMessage,
  ProviderControlsListResponseMessage,
  ServerInfoStatusPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

/**
 * COMPAT(providerOptionControls): added in v0.15.0, remove after 2027-05-01 once daemon floor >=
 * v0.15.0.
 *
 * A daemon without `server_info.features.providerOptionControls` sends `features` (a control with
 * its value attached) and takes composer values as `featureValues`. This is the one place that
 * turns that into the shape everyone else uses: `controls` over `options`, written through
 * `providerOptions`.
 */
export function usesLegacyProviderOptions(info: ServerInfoStatusPayload): boolean {
  return info.features?.providerOptionControls !== true;
}

export class LegacyProviderOptions {
  /** Gives agent snapshots `controls` and `options`, built from their `features`. */
  normalize(message: SessionOutboundMessage): SessionOutboundMessage {
    switch (message.type) {
      case "agent_update":
        if (message.payload.kind !== "upsert") return message;
        return {
          ...message,
          payload: { ...message.payload, agent: this.snapshot(message.payload.agent) },
        };
      case "agent_status":
        return {
          ...message,
          payload: { ...message.payload, info: this.snapshot(message.payload.info) },
        };
      case "fetch_agents_response":
        return {
          ...message,
          payload: {
            ...message.payload,
            entries: message.payload.entries.map((entry) => ({
              ...entry,
              agent: this.snapshot(entry.agent),
            })),
          },
        };
      case "fetch_agent_response":
      case "agent.create.response":
      case "cancel_agent_response":
        return {
          ...message,
          payload: {
            ...message.payload,
            agent: message.payload.agent && this.snapshot(message.payload.agent),
          },
        } as SessionOutboundMessage;
      case "workspace.create.response":
        return {
          ...message,
          payload: {
            ...message.payload,
            ...(message.payload.agent ? { agent: this.snapshot(message.payload.agent) } : {}),
          },
        };
      case "wait_for_finish_response":
        return {
          ...message,
          payload: {
            ...message.payload,
            final: message.payload.final && this.snapshot(message.payload.final),
          },
        };
      case "get_daemon_config_response":
      case "set_daemon_config_response":
        return {
          ...message,
          payload: { ...message.payload, config: this.daemonConfig(message.payload.config) },
        };
      case "status":
        if (message.payload.status !== "daemon_config_changed") return message;
        return {
          ...message,
          payload: {
            ...message.payload,
            config: this.daemonConfig(message.payload.config as MutableDaemonConfig),
          },
        } as SessionOutboundMessage;
      default:
        return message;
    }
  }

  /**
   * Splits a create's options for a legacy daemon: the ids it lists as features for that very
   * config go out as `featureValues`, which is where it reads them, and the rest stay
   * `providerOptions`. Which options are features depends on the model, mode and thinking level
   * as well as the provider, so the ids come from a listing for this config, never from memory.
   */
  routeCreateConfig<
    T extends {
      providerOptions?: Record<string, unknown>;
      featureValues?: Record<string, unknown>;
    },
  >(config: T, featureIds: ReadonlySet<string>): T {
    if (!config.providerOptions) return config;
    const featureValues: Record<string, unknown> = {};
    const providerOptions: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config.providerOptions)) {
      (featureIds.has(key) ? featureValues : providerOptions)[key] = value;
    }
    const { providerOptions: _options, ...rest } = config;
    return {
      ...(rest as T),
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      ...(Object.keys(featureValues).length > 0
        ? { featureValues: { ...config.featureValues, ...featureValues } }
        : {}),
    };
  }

  /** Sends options as `featureValues`, which is where a legacy daemon reads them. */
  prepare(message: SessionInboundMessage): SessionInboundMessage {
    switch (message.type) {
      case "agent.config.apply.request": {
        const { options, ...config } = message.config;
        if (!options) return message;
        return {
          ...message,
          config: { ...config, featureValues: { ...config.featureValues, ...options } },
        };
      }
      case "list_commands_request": {
        if (!message.draftConfig?.providerOptions) return message;
        const { providerOptions, ...draftConfig } = message.draftConfig;
        return {
          ...message,
          draftConfig: {
            ...draftConfig,
            featureValues: { ...draftConfig.featureValues, ...providerOptions },
          },
        };
      }
      case "set_daemon_config_request":
        if (!message.config.agentProfiles) return message;
        return {
          ...message,
          config: {
            ...message.config,
            agentProfiles: message.config.agentProfiles.map(profileWithFeatureValues),
          },
        };
      default:
        return message;
    }
  }

  /** The legacy answer to a controls listing, in the shape of the current response. */
  controlsResponse(
    legacy: ListProviderFeaturesResponseMessage["payload"],
  ): ProviderControlsListResponseMessage["payload"] {
    const { features, ...rest } = legacy;
    return {
      ...rest,
      ...(features
        ? { controls: controlsFromFeatures(features), options: optionsFromFeatures(features) }
        : {}),
    };
  }

  private daemonConfig(config: MutableDaemonConfig): MutableDaemonConfig {
    if (!config.agentProfiles) return config;
    return { ...config, agentProfiles: config.agentProfiles.map(profileWithOptions) };
  }

  private readonly snapshot = (agent: AgentSnapshotPayload): AgentSnapshotPayload => {
    if (agent.controls || !agent.features) return agent;
    return {
      ...agent,
      controls: controlsFromFeatures(agent.features),
      options: optionsFromFeatures(agent.features),
    };
  };
}

/** A legacy daemon stores a profile's options under `featureValues`. */
function profileWithOptions(profile: AgentProfile): AgentProfile {
  if (profile.options || !profile.featureValues) return profile;
  const { featureValues, ...rest } = profile;
  return { ...rest, options: featureValues };
}

function profileWithFeatureValues(profile: AgentProfile): AgentProfile {
  if (!profile.options) return profile;
  const { options, ...rest } = profile;
  return { ...rest, featureValues: options };
}
