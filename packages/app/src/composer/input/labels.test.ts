import { describe, expect, it } from "vitest";
import {
  resolveSendTooltipLabel,
  resolveSubmitAccessibilityLabel,
  resolveVoiceAccessibilityLabel,
  resolveVoiceTooltipText,
} from "./labels";

const translations: Record<string, string> = {
  "composer.input.interruptAgent": "Interrupt agent",
  "composer.input.queueMessage": "Queue message",
  "composer.input.sendAndInterrupt": "Send and interrupt",
  "composer.input.sendMessage": "Send message",
  "composer.input.queue": "Queue",
  "composer.input.send": "Send",
  "composer.voice.unmuteVoiceMode": "Unmute Voice mode",
  "composer.voice.muteVoiceMode": "Mute Voice mode",
  "composer.voice.stopDictation": "Stop dictation",
  "composer.voice.startDictation": "Start dictation",
  "composer.voice.unmuteVoice": "Unmute voice",
  "composer.voice.muteVoice": "Mute voice",
  "composer.voice.dictation": "Dictation",
};

const t = ((key: string) => translations[key] ?? key) as never;

describe("composer input labels", () => {
  it("resolves submit accessibility labels from translations", () => {
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: true,
        defaultActionQueues: false,
        isAgentRunning: true,
        t,
      }),
    ).toBe("Interrupt agent");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: true,
        isAgentRunning: true,
        t,
      }),
    ).toBe("Queue message");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: false,
        isAgentRunning: true,
        t,
      }),
    ).toBe("Send and interrupt");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: false,
        isAgentRunning: false,
        t,
      }),
    ).toBe("Send message");
  });

  it("keeps explicit submit labels untouched", () => {
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: "Run now",
        canPressLoadingButton: false,
        defaultActionQueues: false,
        isAgentRunning: false,
        t,
      }),
    ).toBe("Run now");
  });

  it("resolves voice labels from translations", () => {
    expect(
      resolveVoiceAccessibilityLabel({
        isRealtimeVoiceForCurrentAgent: true,
        isMuted: true,
        isDictating: false,
        t,
      }),
    ).toBe("Unmute Voice mode");
    expect(
      resolveVoiceAccessibilityLabel({
        isRealtimeVoiceForCurrentAgent: true,
        isMuted: false,
        isDictating: false,
        t,
      }),
    ).toBe("Mute Voice mode");
    expect(
      resolveVoiceAccessibilityLabel({
        isRealtimeVoiceForCurrentAgent: false,
        isMuted: false,
        isDictating: true,
        t,
      }),
    ).toBe("Stop dictation");
    expect(
      resolveVoiceAccessibilityLabel({
        isRealtimeVoiceForCurrentAgent: false,
        isMuted: false,
        isDictating: false,
        t,
      }),
    ).toBe("Start dictation");
  });

  it("resolves tooltip labels from translations", () => {
    expect(
      resolveVoiceTooltipText({
        isRealtimeVoiceForCurrentAgent: false,
        isMuted: false,
        t,
      }),
    ).toBe("Dictation");
    expect(
      resolveSendTooltipLabel({
        submitButtonAccessibilityLabel: undefined,
        defaultActionQueues: true,
        t,
      }),
    ).toBe("Queue");
    expect(
      resolveSendTooltipLabel({
        submitButtonAccessibilityLabel: undefined,
        defaultActionQueues: false,
        t,
      }),
    ).toBe("Send");
  });
});
