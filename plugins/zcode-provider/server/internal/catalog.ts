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
