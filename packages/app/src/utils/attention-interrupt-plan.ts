import type { AttentionSoundPreset } from "@/hooks/use-settings/storage";

export type AttentionFocusTarget = { kind: "agent"; id: string } | { kind: "terminal"; id: string };

export interface AttentionInterruptSettings {
  attentionIntrusiveMode: boolean;
  attentionOsBubbleEnabled: boolean;
  attentionSoundEnabled: boolean;
  attentionSoundPreset: AttentionSoundPreset;
}

export interface PlanAttentionInterruptInput {
  settings: AttentionInterruptSettings;
  isActivelyVisible: boolean;
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
  target: AttentionFocusTarget;
}

export interface AttentionInterruptPlan {
  suppress: boolean;
  showOsBubble: boolean;
  showBanner: boolean;
  intrusiveFocusAndNavigate: boolean;
  playSound: boolean;
  soundPreset: AttentionSoundPreset;
}

function isFocusedOnTarget(
  input: Pick<PlanAttentionInterruptInput, "focusedAgentId" | "focusedTerminalId" | "target">,
): boolean {
  if (input.target.kind === "agent") {
    return input.focusedAgentId === input.target.id;
  }
  return input.focusedTerminalId === input.target.id;
}

/**
 * Client-side interrupt planner for attention events that already have shouldNotify.
 * Daemon presence selection is assumed; this only chooses delivery channels.
 */
export function planAttentionInterrupt(input: PlanAttentionInterruptInput): AttentionInterruptPlan {
  const { settings, isActivelyVisible } = input;
  const focusedOnTarget = isActivelyVisible && isFocusedOnTarget(input);
  const soundPreset = settings.attentionSoundPreset;

  if (focusedOnTarget) {
    return {
      suppress: true,
      showOsBubble: false,
      showBanner: false,
      intrusiveFocusAndNavigate: false,
      playSound: false,
      soundPreset,
    };
  }

  if (isActivelyVisible) {
    // Focused in Paseo, wrong agent/terminal: banner is primary.
    return {
      suppress: false,
      showOsBubble: settings.attentionOsBubbleEnabled,
      showBanner: true,
      intrusiveFocusAndNavigate: false,
      playSound: settings.attentionSoundEnabled,
      soundPreset,
    };
  }

  // Unfocused / other app / other Space.
  if (settings.attentionIntrusiveMode) {
    return {
      suppress: false,
      showOsBubble: settings.attentionOsBubbleEnabled,
      showBanner: false,
      intrusiveFocusAndNavigate: true,
      playSound: settings.attentionSoundEnabled,
      soundPreset,
    };
  }

  // Intrusive off: bubble if enabled; sound-only if bubble off (design v1 rule).
  if (settings.attentionOsBubbleEnabled) {
    return {
      suppress: false,
      showOsBubble: true,
      showBanner: false,
      intrusiveFocusAndNavigate: false,
      playSound: settings.attentionSoundEnabled,
      soundPreset,
    };
  }

  return {
    suppress: false,
    showOsBubble: false,
    showBanner: false,
    intrusiveFocusAndNavigate: false,
    playSound: settings.attentionSoundEnabled,
    soundPreset,
  };
}
