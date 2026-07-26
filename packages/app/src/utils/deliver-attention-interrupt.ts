import { queryClient } from "@/data/query-client";
import { getDesktopWindow } from "@/desktop/electron/window";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { useAttentionBannerStore } from "@/stores/attention-banner-store";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import {
  planAttentionInterrupt,
  type AttentionFocusTarget,
} from "@/utils/attention-interrupt-plan";
import { playAttentionSound } from "@/utils/attention-sound";
import { buildNotificationRoute } from "@/utils/notification-routing";
import { sendOsNotification } from "@/utils/os-notifications";

export interface DeliverAttentionInterruptInput {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  target: AttentionFocusTarget;
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
  isActivelyVisible?: boolean;
  navigate?: (route: string) => void;
}

function readAppSettings(): AppSettings {
  const cached = queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY);
  if (cached) {
    return normalizeAppSettings(cached);
  }
  return DEFAULT_CLIENT_SETTINGS;
}

async function focusDesktopWindow(): Promise<void> {
  const focus = getDesktopWindow()?.focus;
  if (typeof focus === "function") {
    try {
      await focus();
    } catch {
      // Best-effort focus.
    }
  }
}

/**
 * Execute client-side attention interrupt channels after shouldNotify is true.
 *
 * Sound routing:
 * - OS bubble + sound → Electron Notification silent:false (OS owns audio)
 * - banner / intrusive / sound-only + sound → in-app playAttentionSound
 */
export async function deliverAttentionInterrupt(
  input: DeliverAttentionInterruptInput,
): Promise<void> {
  const settings = readAppSettings();
  const isActivelyVisible = input.isActivelyVisible ?? getIsAppActivelyVisible();
  const plan = planAttentionInterrupt({
    settings: {
      attentionIntrusiveMode: settings.attentionIntrusiveMode,
      attentionOsBubbleEnabled: settings.attentionOsBubbleEnabled,
      attentionSoundEnabled: settings.attentionSoundEnabled,
      attentionSoundPreset: settings.attentionSoundPreset,
    },
    isActivelyVisible,
    focusedAgentId: input.focusedAgentId,
    focusedTerminalId: input.focusedTerminalId,
    target: input.target,
  });

  if (plan.suppress) {
    return;
  }

  if (plan.showOsBubble) {
    await sendOsNotification({
      title: input.title,
      body: input.body,
      data: input.data,
      silent: !plan.playSound,
    });
  }

  if (plan.intrusiveFocusAndNavigate) {
    await focusDesktopWindow();
    const route = buildNotificationRoute(input.data);
    if (input.navigate) {
      input.navigate(route);
    } else {
      const location = (
        globalThis as { location?: { assign?: (url: string) => void; href?: string } }
      ).location;
      if (location && typeof location.assign === "function") {
        location.assign(route);
      } else if (location && typeof location.href === "string") {
        location.href = route;
      }
    }
  }

  if (plan.showBanner) {
    useAttentionBannerStore.getState().show({
      title: input.title,
      body: input.body,
      data: input.data,
    });
  }

  // In-app sound when OS bubble is not carrying the audio.
  if (plan.playSound && !plan.showOsBubble) {
    playAttentionSound(plan.soundPreset);
  }
}
