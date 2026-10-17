import { describe, expect, it, vi } from "vitest";
import {
  applyDictationTranscript,
  canOwnHardwareKeyboardSubmit,
  computeCanStartDictation,
  resolveActiveSendBehavior,
  resolveComposerEnterAction,
  resolveComposerSurfacePresentation,
  resolveComposerSurfaceText,
  resolveGlyphRailOffset,
  resolveRetainedSelection,
  runAlternateSendAction,
  runDefaultSendAction,
  runHardwareKeyboardEnter,
  runMessageInputKeyboardAction,
  stopRealtimeVoice,
} from "./state";

const connected = { isConnected: true } as never;
const disconnected = { isConnected: false } as never;

function createDictationKeyboard({ startsRecording }: { startsRecording: boolean }) {
  let isRecording = false;
  const actions: string[] = [];

  return {
    actions,
    pressDictationShortcut: () =>
      runMessageInputKeyboardAction("dictation-toggle", {
        focusInput: () => undefined,
        isDictationRecording: () => isRecording,
        markTranscriptForSend: () => actions.push("send transcript"),
        startDictation: () => {
          actions.push("start");
          isRecording = startsRecording;
        },
        confirmDictation: () => {
          actions.push("confirm");
          isRecording = false;
        },
        cancelDictation: () => undefined,
        toggleRealtimeVoice: () => undefined,
        isRealtimeVoiceActive: false,
        toggleRealtimeVoiceMute: () => undefined,
      }),
  };
}

describe("composer surface presentation", () => {
  it("shows only the input when no voice overlay is active", () => {
    expect(resolveComposerSurfacePresentation(false)).toEqual({
      input: { opacity: 1, pointerEvents: "auto" },
      overlay: { opacity: 0, pointerEvents: "none" },
    });
  });

  it("shows only the voice overlay while voice UI is active", () => {
    expect(resolveComposerSurfacePresentation(true)).toEqual({
      input: { opacity: 0, pointerEvents: "none" },
      overlay: { opacity: 1, pointerEvents: "auto" },
    });
  });
});

const ENTER = { shiftKey: false, ctrlKey: false, metaKey: false };
const SHIFT_ENTER = { ...ENTER, shiftKey: true };
const CTRL_ENTER = { ...ENTER, ctrlKey: true };
const META_ENTER = { ...ENTER, metaKey: true };

describe("composer Enter rules", () => {
  const wideIdle = {
    submitOnEnter: true,
    isAgentRunning: false,
    canQueue: true,
    isSendBlocked: false,
  };
  const wideRunning = { ...wideIdle, isAgentRunning: true };

  it("sends the default action on Enter and leaves Shift+Enter as a newline", () => {
    expect(resolveComposerEnterAction(ENTER, wideIdle)).toBe("default");
    expect(resolveComposerEnterAction(SHIFT_ENTER, wideIdle)).toBe("pass-through");
    expect(resolveComposerEnterAction({ ...SHIFT_ENTER, ctrlKey: true }, wideRunning)).toBe(
      "pass-through",
    );
  });

  it("uses Ctrl or Meta+Enter for the alternate action only while a queueable agent runs", () => {
    expect(resolveComposerEnterAction(CTRL_ENTER, wideRunning)).toBe("alternate");
    expect(resolveComposerEnterAction(META_ENTER, wideRunning)).toBe("alternate");
    expect(resolveComposerEnterAction(CTRL_ENTER, wideIdle)).toBe("default");
    expect(resolveComposerEnterAction(META_ENTER, { ...wideRunning, canQueue: false })).toBe(
      "default",
    );
  });

  it("leaves every Enter as a newline on compact layouts or while sending is blocked", () => {
    for (const keys of [ENTER, CTRL_ENTER, META_ENTER]) {
      expect(resolveComposerEnterAction(keys, { ...wideRunning, submitOnEnter: false })).toBe(
        "pass-through",
      );
      expect(resolveComposerEnterAction(keys, { ...wideRunning, isSendBlocked: true })).toBe(
        "pass-through",
      );
    }
  });
});

describe("hardware keyboard submit ownership", () => {
  const owning = {
    isInputFocused: true,
    isSendButtonDisabled: false,
    readOnly: false,
    isDictating: false,
    showOverlay: false,
    isRealtimeVoiceForCurrentAgent: false,
    isSendBlocked: false,
  };

  it("lets a focused composer that can send own submission under either rules", () => {
    expect(canOwnHardwareKeyboardSubmit({ ...owning, rules: "send-button" })).toBe(true);
    expect(canOwnHardwareKeyboardSubmit({ ...owning, rules: "desktop" })).toBe(true);
  });

  it.each([
    ["unfocused", { isInputFocused: false }],
    ["read-only", { readOnly: true }],
    ["dictating", { isDictating: true }],
    ["hidden behind the voice overlay", { showOverlay: true }],
    ["in realtime voice", { isRealtimeVoiceForCurrentAgent: true }],
  ])("never lets a %s composer own submission", (_label, override) => {
    expect(canOwnHardwareKeyboardSubmit({ ...owning, ...override, rules: "send-button" })).toBe(
      false,
    );
    expect(canOwnHardwareKeyboardSubmit({ ...owning, ...override, rules: "desktop" })).toBe(false);
  });

  it("keeps the send-button gate for iOS", () => {
    expect(
      canOwnHardwareKeyboardSubmit({ ...owning, rules: "send-button", isSendButtonDisabled: true }),
    ).toBe(false);
    expect(
      canOwnHardwareKeyboardSubmit({ ...owning, rules: "send-button", isSendBlocked: true }),
    ).toBe(true);
  });

  it("releases desktop-rule ownership while sending is blocked", () => {
    expect(canOwnHardwareKeyboardSubmit({ ...owning, rules: "desktop", isSendBlocked: true })).toBe(
      false,
    );
  });
});

describe("hardware keyboard Enter", () => {
  function createEnterContext(
    overrides: Partial<Parameters<typeof runHardwareKeyboardEnter>[1]> = {},
  ) {
    const actions: string[] = [];
    const ctx = {
      rules: "desktop" as const,
      isAgentRunning: true,
      canQueue: true,
      isSendBlocked: false,
      handleKeyPress: () => false,
      handleDefaultSendAction: () => actions.push("default"),
      handleAlternateSendAction: () => actions.push("alternate"),
      ...overrides,
    };
    return { actions, ctx };
  }

  it("runs the desktop default and alternate actions for Android", () => {
    const { actions, ctx } = createEnterContext();
    runHardwareKeyboardEnter(ENTER, ctx);
    runHardwareKeyboardEnter(CTRL_ENTER, ctx);
    runHardwareKeyboardEnter(META_ENTER, { ...ctx, isAgentRunning: false });
    expect(actions).toEqual(["default", "alternate", "default"]);
  });

  // Native only reports Enter from a physical keyboard; touch and IME input never get here. The
  // window width must not matter: a phone or a narrow pane with a keyboard attached sends too.
  it("routes a physical keyboard Enter by composer state alone, at any window width", () => {
    const owner = {
      rules: "desktop" as const,
      isInputFocused: true,
      isSendButtonDisabled: false,
      readOnly: false,
      isDictating: false,
      showOverlay: false,
      isRealtimeVoiceForCurrentAgent: false,
      isSendBlocked: false,
    };
    expect(canOwnHardwareKeyboardSubmit(owner)).toBe(true);

    const { actions, ctx } = createEnterContext();
    runHardwareKeyboardEnter(ENTER, ctx);
    runHardwareKeyboardEnter(CTRL_ENTER, ctx);
    expect(actions).toEqual(["default", "alternate"]);
  });

  it("lets autocomplete take Enter before any send action", () => {
    const { actions, ctx } = createEnterContext({ handleKeyPress: () => true });
    runHardwareKeyboardEnter(CTRL_ENTER, ctx);
    expect(actions).toEqual([]);
  });

  it("does nothing for a consumed press once the composer can no longer send", () => {
    const { actions, ctx } = createEnterContext({ isSendBlocked: true });
    runHardwareKeyboardEnter(ENTER, ctx);
    expect(actions).toEqual([]);
  });

  it("keeps iOS on the send button action", () => {
    let autocompleteCalls = 0;
    const { actions, ctx } = createEnterContext({
      rules: "send-button",
      handleKeyPress: () => {
        autocompleteCalls += 1;
        return true;
      },
    });
    runHardwareKeyboardEnter(ENTER, ctx);
    expect(actions).toEqual(["default"]);
    expect(autocompleteCalls).toBe(0);
  });
});

describe("computeCanStartDictation", () => {
  it("returns false when socket is disconnected", () => {
    expect(
      computeCanStartDictation({
        client: disconnected,
        isReadyForDictation: true,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });

  it("returns false when isReadyForDictation is explicitly false", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: false,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });

  it("returns true when connected and ready", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: true,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(true);
  });

  it("falls back to socket connected state when isReadyForDictation is undefined", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: undefined,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(true);

    expect(
      computeCanStartDictation({
        client: disconnected,
        isReadyForDictation: undefined,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });

  it("returns false when the input is disabled", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: true,
        disabled: true,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });

  it("returns false when a dictation unavailable message is present", () => {
    expect(
      computeCanStartDictation({
        client: connected,
        isReadyForDictation: true,
        disabled: false,
        dictationUnavailableMessage: "Microphone unavailable",
      }),
    ).toBe(false);
  });

  it("returns false when client is null", () => {
    expect(
      computeCanStartDictation({
        client: null,
        isReadyForDictation: true,
        disabled: false,
        dictationUnavailableMessage: null,
      }),
    ).toBe(false);
  });
});

describe("dictation keyboard behavior", () => {
  it("starts dictation again after the previous dictation finishes", () => {
    const keyboard = createDictationKeyboard({ startsRecording: true });

    keyboard.pressDictationShortcut();
    keyboard.pressDictationShortcut();
    keyboard.pressDictationShortcut();

    expect(keyboard.actions).toEqual(["start", "send transcript", "confirm", "start"]);
  });

  it("can retry when starting dictation does not enter the recording state", () => {
    const keyboard = createDictationKeyboard({ startsRecording: false });

    keyboard.pressDictationShortcut();
    keyboard.pressDictationShortcut();

    expect(keyboard.actions).toEqual(["start", "start"]);
  });
});

describe("dictation transcript behavior", () => {
  it("publishes an auto-sent transcript to the composer before submitting it", () => {
    const actions: string[] = [];

    applyDictationTranscript("spoken prompt", {
      value: "typed context",
      defaultSendBehavior: "interrupt",
      isAgentRunning: false,
      onQueue: undefined,
      replaceText: (text) => actions.push(`replace:${text}`),
      onSubmit: (payload) => actions.push(`submit:${payload.text}`),
      attachments: [],
      cwd: "/repo",
      autoSend: true,
    });

    expect(actions).toEqual([
      "replace:typed context spoken prompt",
      "submit:typed context spoken prompt",
    ]);
  });
});

describe("composer send behavior", () => {
  it("sends immediately when queue mode cannot advance past a permission", () => {
    expect(resolveActiveSendBehavior("queue", true)).toBe("interrupt");
    expect(resolveActiveSendBehavior("queue", false)).toBe("queue");
    expect(resolveActiveSendBehavior("steer", true)).toBe("steer");
  });

  function actions() {
    const calls: string[] = [];
    return {
      calls,
      handleSendMessage: () => calls.push("send"),
      handleQueueMessage: () => calls.push("queue"),
      onQueue: () => undefined,
    };
  }

  it("uses Enter to interrupt and Mod+Enter to queue when interrupt is selected", () => {
    const defaultAction = actions();
    runDefaultSendAction({
      defaultSendBehavior: "interrupt",
      isAgentRunning: true,
      onQueue: defaultAction.onQueue,
      handleSendMessage: defaultAction.handleSendMessage,
      handleQueueMessage: defaultAction.handleQueueMessage,
    });

    const alternateAction = actions();
    runAlternateSendAction({
      defaultSendBehavior: "interrupt",
      isAgentRunning: true,
      onQueue: alternateAction.onQueue,
      handleSendMessage: alternateAction.handleSendMessage,
      handleQueueMessage: alternateAction.handleQueueMessage,
    });

    expect(defaultAction.calls).toEqual(["send"]);
    expect(alternateAction.calls).toEqual(["queue"]);
  });

  it("uses Enter to steer and Mod+Enter to queue when steer is selected", () => {
    const defaultAction = actions();
    runDefaultSendAction({
      defaultSendBehavior: "steer",
      isAgentRunning: true,
      onQueue: defaultAction.onQueue,
      handleSendMessage: defaultAction.handleSendMessage,
      handleQueueMessage: defaultAction.handleQueueMessage,
    });

    const alternateAction = actions();
    runAlternateSendAction({
      defaultSendBehavior: "steer",
      isAgentRunning: true,
      onQueue: alternateAction.onQueue,
      handleSendMessage: alternateAction.handleSendMessage,
      handleQueueMessage: alternateAction.handleQueueMessage,
    });

    expect(defaultAction.calls).toEqual(["send"]);
    expect(alternateAction.calls).toEqual(["queue"]);
  });

  it("uses Enter to queue and Mod+Enter to submit when queue is selected", () => {
    const defaultAction = actions();
    runDefaultSendAction({
      defaultSendBehavior: "queue",
      isAgentRunning: true,
      onQueue: defaultAction.onQueue,
      handleSendMessage: defaultAction.handleSendMessage,
      handleQueueMessage: defaultAction.handleQueueMessage,
    });

    const alternateAction = actions();
    runAlternateSendAction({
      defaultSendBehavior: "queue",
      isAgentRunning: true,
      onQueue: alternateAction.onQueue,
      handleSendMessage: alternateAction.handleSendMessage,
      handleQueueMessage: alternateAction.handleQueueMessage,
    });

    expect(defaultAction.calls).toEqual(["queue"]);
    expect(alternateAction.calls).toEqual(["send"]);
  });
});

describe("stopRealtimeVoice", () => {
  it("keeps voice mode active when the running agent refuses cancellation", async () => {
    const cancellationError = new Error("active run cancellation was not acknowledged");
    const cancelAgent = vi.fn().mockRejectedValue(cancellationError);
    const stopVoice = vi.fn().mockResolvedValue(undefined);

    await expect(
      stopRealtimeVoice({
        voice: { stopVoice },
        isRealtimeVoiceForCurrentAgent: true,
        isAgentRunning: true,
        client: { cancelAgent },
        voiceAgentId: "agent-1",
      }),
    ).rejects.toBe(cancellationError);

    expect(stopVoice).not.toHaveBeenCalled();
  });

  it("stops voice mode after the running agent acknowledges cancellation", async () => {
    const calls: string[] = [];

    await stopRealtimeVoice({
      voice: {
        stopVoice: async () => {
          calls.push("stop voice");
        },
      },
      isRealtimeVoiceForCurrentAgent: true,
      isAgentRunning: true,
      client: {
        cancelAgent: async () => {
          calls.push("cancel agent");
        },
      },
      voiceAgentId: "agent-1",
    });

    expect(calls).toEqual(["cancel agent", "stop voice"]);
  });
});

describe("composer surface text", () => {
  it("measures a new nonempty replacement before it reaches the editing handle", () => {
    const replacement = { kind: "replace" as const, key: "draft:2", text: "First\nSecond\nThird" };
    expect(resolveComposerSurfaceText("Short draft", replacement, "draft:1")).toBe(
      replacement.text,
    );
  });

  it("keeps live typing once the replacement is applied", () => {
    const replacement = { kind: "replace" as const, key: "draft:2", text: "First\nSecond\nThird" };
    expect(resolveComposerSurfaceText("Edited live draft", replacement, "draft:2")).toBe(
      "Edited live draft",
    );
  });

  it("keeps the live buffer when the initial publication is already applied", () => {
    const replacement = { kind: "initial" as const, key: "draft:0", text: "Stale publication" };
    expect(resolveComposerSurfaceText("Live edited draft", replacement, "draft:0")).toBe(
      "Live edited draft",
    );
  });
});

describe("retained selection", () => {
  it("keeps a caret that fits and clamps one that no longer does", () => {
    expect(resolveRetainedSelection({ start: 4, end: 17 }, 40)).toEqual({ start: 4, end: 17 });
    expect(resolveRetainedSelection({ start: 4, end: 17 }, 10)).toEqual({ start: 4, end: 10 });
    expect(resolveRetainedSelection({ start: 12, end: 17 }, 10)).toEqual({ start: 10, end: 10 });
    expect(resolveRetainedSelection({ start: -1, end: 3 }, 10)).toEqual({ start: 0, end: 3 });
  });
});

describe("fullscreen glyph rail", () => {
  it("nudges 16px fullscreen glyphs onto the Send arrow's ink edge", () => {
    expect(
      resolveGlyphRailOffset({ controlSize: 28, sendIconSize: 16, glyphIconSize: 16 }),
    ).toBeCloseTo(4 / 3);
    expect(
      resolveGlyphRailOffset({ controlSize: 28, sendIconSize: 20, glyphIconSize: 16 }),
    ).toBeCloseTo(1 / 6);
  });
});
