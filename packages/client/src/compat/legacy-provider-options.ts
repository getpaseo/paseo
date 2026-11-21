import { controlsFromFeatures, optionsFromFeatures } from "@getpaseo/protocol/option-controls";
import type { AgentOptionControl } from "@getpaseo/protocol/agent-types";
import type {
  AgentConfigApply,
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
      case "fetch_agent_timeline_response":
        return {
          ...message,
          payload: {
            ...message.payload,
            agent: message.payload.agent && this.snapshot(message.payload.agent),
          },
        };
      case "status":
        return this.status(message);
      default:
        return message;
    }
  }

  private status(
    message: Extract<SessionOutboundMessage, { type: "status" }>,
  ): SessionOutboundMessage {
    const { payload } = message;
    if (payload.status === "agent_created" || payload.status === "agent_resumed") {
      const { agent } = payload as unknown as { agent: AgentSnapshotPayload };
      return { ...message, payload: { ...payload, agent: this.snapshot(agent) } };
    }
    if (payload.status === "daemon_config_changed") {
      const config = payload.config as MutableDaemonConfig;
      return { ...message, payload: { ...payload, config: this.daemonConfig(config) } };
    }
    return message;
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

  /**
   * An options patch as feature writes. `null` removes an option, which the old API cannot say:
   * its setters take a value, and the Codex one rejects anything but a choice id. A toggle goes
   * off and a choice goes to its default; an option with no control to say what its default is
   * cannot be reset, and nothing is written.
   */
  featureWrites(
    patch: Record<string, unknown>,
    controls: readonly AgentOptionControl[],
  ): [string, unknown][] {
    return Object.entries(patch).map(([key, value]) => {
      if (value !== null) return [key, value];
      const control = controls.find((candidate) => candidate.key === key);
      if (control?.type === "toggle") return [key, false];
      if (control?.type === "select" && control.defaultValue !== undefined) {
        return [key, control.defaultValue];
      }
      throw new Error(`Update the host to reset ${key}.`);
    });
  }

  /** A config apply with its `options` as `featureValues`, the way a daemon without them takes it. */
  featureValuesConfig(
    config: AgentConfigApply,
    controls: readonly AgentOptionControl[],
  ): AgentConfigApply {
    const { options, ...rest } = config;
    if (!options) return config;
    return {
      ...rest,
      featureValues: {
        ...rest.featureValues,
        ...Object.fromEntries(this.featureWrites(options, controls)),
      },
    };
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

/**
 * A legacy daemon stores a profile's options under `featureValues`, and keeps an `options` field
 * a newer daemon left on it. Both are read, and an explicit `options` key wins, as it does on the
 * daemon (`foldFeatureValues`).
 */
function profileWithOptions(profile: AgentProfile): AgentProfile {
  if (!profile.featureValues) return profile;
  const { featureValues, ...rest } = profile;
  return { ...rest, options: { ...featureValues, ...profile.options } };
}

function profileWithFeatureValues(profile: AgentProfile): AgentProfile {
  if (!profile.options) return profile;
  const { options, ...rest } = profile;
  return { ...rest, featureValues: options };
}
