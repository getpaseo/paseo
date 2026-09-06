import type {
  MutableDaemonConfigPatch,
  SetDaemonConfigResponseMessage,
} from "@getpaseo/protocol/messages";
import type { RelaySettingsFormModel, RelaySettingsValues } from "./relay-settings-form-model";

type RelayPatchResult = Pick<
  SetDaemonConfigResponseMessage["payload"],
  "config" | "restartRequiredPaths"
>;

export async function submitRelaySettings(input: {
  model: RelaySettingsFormModel;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<RelayPatchResult | undefined>;
  migrateRelayConnection: (relay: RelaySettingsValues) => Promise<unknown>;
  restart: () => Promise<unknown>;
  canDisableRelay: () => boolean;
  formatDisableRelayError: () => string;
  formatSaveError: (error: unknown) => string;
  formatMigrationError: (error: unknown) => string;
  formatRestartError: (error: unknown) => string;
}): Promise<"close" | "stayOpen"> {
  const activate = async (relay: RelaySettingsValues): Promise<"close" | "stayOpen"> => {
    input.model.startMigrating();
    try {
      await input.migrateRelayConnection(relay);
    } catch (error) {
      input.model.markMigrationFailed(input.formatMigrationError(error));
      return "stayOpen";
    }

    input.model.startRestarting();
    try {
      await input.restart();
      return "close";
    } catch (error) {
      input.model.markRestartFailed(input.formatRestartError(error));
      return "stayOpen";
    }
  };

  const state = input.model.getState();
  if (state.phase === "restartRequired") {
    return activate(state.values);
  }
  if (state.phase !== "editing") return "stayOpen";

  const patch = input.model.buildPatch();
  if (!patch) return "stayOpen";
  if (patch.relay?.enabled === false && !input.canDisableRelay()) {
    input.model.markRelayDisableBlocked(input.formatDisableRelayError());
    return "stayOpen";
  }
  input.model.startSaving();
  try {
    const result = await input.patchConfig(patch);
    if (!result) throw new Error("Host disconnected");
    if ((result.restartRequiredPaths ?? []).length === 0) return "close";

    const relay = result.config.relay;
    if (!relay?.endpoint || !relay.publicEndpoint) {
      throw new Error("Daemon returned an incomplete relay config");
    }
    const savedValues: RelaySettingsValues = {
      enabled: relay.enabled,
      endpoint: relay.endpoint,
      publicEndpoint: relay.publicEndpoint,
      useTls: relay.useTls ?? true,
      publicUseTls: relay.publicUseTls ?? relay.useTls ?? true,
    };
    input.model.markRestartRequired(savedValues);
    return activate(savedValues);
  } catch (error) {
    input.model.markSaveFailed(input.formatSaveError(error));
    return "stayOpen";
  }
}
