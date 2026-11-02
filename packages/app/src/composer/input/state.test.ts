import { describe, expect, it, vi } from "vitest";
import {
  applyDictationTranscript,
  computeCanStartDictation,
  type MessageInputEnterContext,
  resolveActiveSendBehavior,
  resolveComposerSurfacePresentation,
  resolveComposerSurfaceText,
  resolveGlyphRailOffset,
  resolveMessageInputEnterAction,
  resolveRetainedSelection,
  resolveAlternateSendAction,
  runAlternateSendAction,
  runDefaultSendAction,
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

  it("sends with the alternate action while no turn is running", () => {
    for (const defaultSendBehavior of ["steer", "interrupt", "queue"] as const) {
      const alternateAction = actions();
      runAlternateSendAction({
        defaultSendBehavior,
        isAgentRunning: false,
        onQueue: alternateAction.onQueue,
        handleSendMessage: alternateAction.handleSendMessage,
        handleQueueMessage: alternateAction.handleQueueMessage,
      });
      expect(alternateAction.calls).toEqual(["send"]);
    }
  });

  it("offers an alternate action only while a turn runs and the composer can queue", () => {
    const onQueue = () => undefined;
    expect(
      resolveAlternateSendAction({ defaultSendBehavior: "steer", isAgentRunning: true, onQueue }),
    ).toBe("queue");
    expect(
      resolveAlternateSendAction({
        defaultSendBehavior: "interrupt",
        isAgentRunning: true,
        onQueue,
      }),
    ).toBe("queue");
    expect(
      resolveAlternateSendAction({ defaultSendBehavior: "queue", isAgentRunning: true, onQueue }),
    ).toBe("send");
    expect(
      resolveAlternateSendAction({ defaultSendBehavior: "steer", isAgentRunning: false, onQueue }),
    ).toBeNull();
    expect(
      resolveAlternateSendAction({
        defaultSendBehavior: "queue",
        isAgentRunning: true,
        onQueue: undefined,
      }),
    ).toBeNull();
  });
});

describe("resolveMessageInputEnterAction", () => {
  function enterContext(
    overrides: Partial<MessageInputEnterContext> = {},
  ): MessageInputEnterContext {
    return {
      submitOnEnter: true,
      sendShortcut: "enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      isAgentRunning: false,
      onQueue: () => undefined,
      ...overrides,
    };
  }

  it("returns null for plain, Shift, and modifier Enter when submit on enter is disabled", () => {
    expect(resolveMessageInputEnterAction(enterContext({ submitOnEnter: false }))).toBeNull();
    expect(
      resolveMessageInputEnterAction(enterContext({ submitOnEnter: false, shiftKey: true })),
    ).toBeNull();
    expect(
      resolveMessageInputEnterAction(enterContext({ submitOnEnter: false, metaKey: true })),
    ).toBeNull();
    expect(
      resolveMessageInputEnterAction(enterContext({ submitOnEnter: false, ctrlKey: true })),
    ).toBeNull();
  });

  it("still returns null when modifier Enter sends and submit on enter is disabled", () => {
    expect(
      resolveMessageInputEnterAction(
        enterContext({ sendShortcut: "mod-enter", submitOnEnter: false, metaKey: true }),
      ),
    ).toBeNull();
    expect(
      resolveMessageInputEnterAction(
        enterContext({ sendShortcut: "mod-enter", submitOnEnter: false }),
      ),
    ).toBeNull();
  });

  it("sends on plain Enter when Enter sends", () => {
    expect(resolveMessageInputEnterAction(enterContext())).toBe("default-send");
  });

  it("returns null for Shift+Enter when Enter sends", () => {
    expect(resolveMessageInputEnterAction(enterContext({ shiftKey: true }))).toBeNull();
  });

  it("returns null for Shift+Cmd+Enter and Shift+Ctrl+Enter so Shift keeps its newline", () => {
    expect(
      resolveMessageInputEnterAction(
        enterContext({ shiftKey: true, metaKey: true, isAgentRunning: true }),
      ),
    ).toBeNull();
    expect(
      resolveMessageInputEnterAction(
        enterContext({ shiftKey: true, ctrlKey: true, isAgentRunning: true }),
      ),
    ).toBeNull();
  });

  it("sends on Cmd+Enter and Ctrl+Enter while idle even with a queue handler", () => {
    expect(resolveMessageInputEnterAction(enterContext({ metaKey: true }))).toBe("default-send");
    expect(resolveMessageInputEnterAction(enterContext({ ctrlKey: true }))).toBe("default-send");
  });

  it("queues on Cmd+Enter and Ctrl+Enter while the agent is running with a queue handler", () => {
    expect(
      resolveMessageInputEnterAction(enterContext({ metaKey: true, isAgentRunning: true })),
    ).toBe("alternate-send");
    expect(
      resolveMessageInputEnterAction(enterContext({ ctrlKey: true, isAgentRunning: true })),
    ).toBe("alternate-send");
  });

  it("sends on Cmd+Enter and Ctrl+Enter while running when no queue handler exists", () => {
    expect(
      resolveMessageInputEnterAction(
        enterContext({ metaKey: true, isAgentRunning: true, onQueue: undefined }),
      ),
    ).toBe("default-send");
    expect(
      resolveMessageInputEnterAction(
        enterContext({ ctrlKey: true, isAgentRunning: true, onQueue: undefined }),
      ),
    ).toBe("default-send");
  });

  it("returns null for plain and Shift+Enter when modifier Enter sends", () => {
    expect(resolveMessageInputEnterAction(enterContext({ sendShortcut: "mod-enter" }))).toBeNull();
    expect(
      resolveMessageInputEnterAction(enterContext({ sendShortcut: "mod-enter", shiftKey: true })),
    ).toBeNull();
  });

  it("returns null for Shift+Cmd+Enter and Shift+Ctrl+Enter when modifier Enter sends", () => {
    expect(
      resolveMessageInputEnterAction(
        enterContext({ sendShortcut: "mod-enter", shiftKey: true, metaKey: true }),
      ),
    ).toBeNull();
    expect(
      resolveMessageInputEnterAction(
        enterContext({ sendShortcut: "mod-enter", shiftKey: true, ctrlKey: true }),
      ),
    ).toBeNull();
  });

  it("sends on Cmd+Enter and Ctrl+Enter while idle when modifier Enter sends", () => {
    expect(
      resolveMessageInputEnterAction(enterContext({ sendShortcut: "mod-enter", metaKey: true })),
    ).toBe("default-send");
    expect(
      resolveMessageInputEnterAction(enterContext({ sendShortcut: "mod-enter", ctrlKey: true })),
    ).toBe("default-send");
  });

  it("uses the default action on modifier Enter while running when modifier Enter sends", () => {
    expect(
      resolveMessageInputEnterAction(
        enterContext({ sendShortcut: "mod-enter", metaKey: true, isAgentRunning: true }),
      ),
    ).toBe("default-send");
    expect(
      resolveMessageInputEnterAction(
        enterContext({ sendShortcut: "mod-enter", ctrlKey: true, isAgentRunning: true }),
      ),
    ).toBe("default-send");
  });

  describe("composed with the send actions", () => {
    function actions() {
      const calls: string[] = [];
      return {
        calls,
        handleSendMessage: () => calls.push("send"),
        handleQueueMessage: () => calls.push("queue"),
        onQueue: () => undefined,
      };
    }

    function resolveCommandEnterToSendModifierEnter() {
      return resolveMessageInputEnterAction(
        enterContext({ sendShortcut: "mod-enter", metaKey: true, isAgentRunning: true }),
      );
    }

    it("queues through the default send action when queue behavior is selected and the agent is running", () => {
      const sendAction = actions();

      expect(resolveCommandEnterToSendModifierEnter()).toBe("default-send");

      runDefaultSendAction({
        defaultSendBehavior: "queue",
        isAgentRunning: true,
        onQueue: sendAction.onQueue,
        handleSendMessage: sendAction.handleSendMessage,
        handleQueueMessage: sendAction.handleQueueMessage,
      });

      expect(sendAction.calls).toEqual(["queue"]);
    });

    it("sends through the default send action when queue behavior is selected and the agent is idle", () => {
      const sendAction = actions();

      expect(
        resolveMessageInputEnterAction(
          enterContext({ sendShortcut: "mod-enter", metaKey: true, isAgentRunning: false }),
        ),
      ).toBe("default-send");

      runDefaultSendAction({
        defaultSendBehavior: "queue",
        isAgentRunning: false,
        onQueue: sendAction.onQueue,
        handleSendMessage: sendAction.handleSendMessage,
        handleQueueMessage: sendAction.handleQueueMessage,
      });

      expect(sendAction.calls).toEqual(["send"]);
    });

    it.each([{ defaultSendBehavior: "steer" }, { defaultSendBehavior: "interrupt" }] as const)(
      "sends through the default send action when $defaultSendBehavior behavior is selected and the agent is running",
      ({ defaultSendBehavior }) => {
        const sendAction = actions();

        expect(resolveCommandEnterToSendModifierEnter()).toBe("default-send");

        runDefaultSendAction({
          defaultSendBehavior,
          isAgentRunning: true,
          onQueue: sendAction.onQueue,
          handleSendMessage: sendAction.handleSendMessage,
          handleQueueMessage: sendAction.handleQueueMessage,
        });

        expect(sendAction.calls).toEqual(["send"]);
      },
    );
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
