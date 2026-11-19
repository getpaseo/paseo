import type { ProviderCatalog } from "@getpaseo/plugin/server/provider";

/**
 * ZCode's session settings, as they arrive on a session snapshot
 * (`packages/shared/src/zcode-protocol/index.ts:1250-1281` in the ZCode
 * repository). The legacy snapshot carries `settings`; the flat
 * `configOptions` array is the v4 workspace-config projection of those same
 * settings, and the app-server never sends it on this path.
 */
export interface ZCodeModelSelection {
  providerId: string;
  modelId: string;
}

export interface ZCodeModelOption {
  ref: ZCodeModelSelection;
  label: string;
  description?: string;
}

export interface ZCodeThoughtLevelOption {
  value: string;
  label: string;
  description?: string;
}

export interface ZCodeSessionSettings {
  model?: {
    current?: ZCodeModelSelection;
    available?: ZCodeModelOption[];
  };
  thoughtLevel?: {
    enabled?: boolean;
    current?: string;
    available?: ZCodeThoughtLevelOption[];
  };
  mode?: {
    current?: string;
  };
}

export interface ZCodeSnapshot {
  settings?: ZCodeSessionSettings;
}

/**
 * The modes ZCode offers, with the labels it uses
 * (`packages/shared/src/zcode-agent-model-state.ts:19-40` in the ZCode
 * repository). ZCode also accepts `edit`, which it keeps as a historical
 * value but hides from the menu, so it is not offered here.
 */
export const ZCODE_MODES = [
  { id: "build", label: "Ask before changes", description: "Ask before each file changes." },
  { id: "guarded", label: "Autonomous mode", description: "Ask when there's risk" },
  {
    id: "plan",
    label: "Plan mode",
    description: "Inspect the code and present a plan before editing.",
  },
  {
    id: "yolo",
    label: "Full access",
    description: "Edit and run commands with fewer confirmations.",
  },
] as const;

/**
 * The model id Paseo carries. ZCode's own picker value is
 * "providerId/modelId" (`packages/shared/src/model-selection.ts:34-40` in the
 * ZCode repository), and the transport turns it back into the pair that
 * `session/setModel` wants.
 */
export function pickerValue(selection: ZCodeModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

/**
 * The catalog Paseo shows for a ZCode session.
 *
 * ZCode projects its model, mode and thought-level options from the session
 * settings, so the snapshot is the only source for them.
 */
export function mapCatalog(snapshot: ZCodeSnapshot): ProviderCatalog {
  const settings = snapshot.settings;
  const models = (settings?.model?.available ?? []).map((option) => ({
    id: pickerValue(option.ref),
    label: option.label,
    description: option.description ?? "",
  }));
  // ZCode reports the thought levels it disabled as unavailable. Offering
  // them would let the user pick a level the agent does not accept.
  const thinkingOptions =
    settings?.thoughtLevel?.enabled === false
      ? []
      : (settings?.thoughtLevel?.available ?? []).map((option) => ({
          id: option.value,
          label: option.label,
          description: option.description ?? "",
        }));
  const defaultModel = settings?.model?.current ? pickerValue(settings.model.current) : undefined;
  const defaultMode = settings?.mode?.current;
  const defaultThinkingOption = settings?.thoughtLevel?.current;

  return {
    models,
    modes: ZCODE_MODES.map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
    })),
    thinkingOptions,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultMode ? { defaultMode } : {}),
    ...(defaultThinkingOption ? { defaultThinkingOption } : {}),
  };
}
