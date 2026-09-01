import { v4 as uuidv4 } from "uuid";
import type {
  SessionOutboundMessage,
  VoiceAppContext,
  VoiceCallInboundMessage,
  VoiceCallOutboundMessage,
  VoiceCallState,
  VoiceCallTransportOffer,
} from "@getpaseo/protocol/messages";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  VoiceCallProvider,
  VoiceProviderCall,
  VoiceProviderOutput,
  VoiceProviderTerminal,
} from "./internal/provider.js";

const UPDATE_APP_MESSAGE = "Update Paseo to use voice chat.";
const CALL_ENDED_MESSAGE = "Voice call is no longer active.";

export interface VoiceChatClientSession {
  handle(message: VoiceCallInboundMessage): Promise<void>;
  disconnect(): Promise<void>;
  close(): Promise<void>;
}

export interface VoiceChat {
  openClientSession(input: {
    emit(message: VoiceCallOutboundMessage): void;
  }): VoiceChatClientSession;
  close(): Promise<void>;
}

export interface CreateVoiceChatOptions {
  provider: VoiceCallProvider | null;
}

interface ActiveCall {
  callId: string;
  context: VoiceAppContext;
  providerCall: VoiceProviderCall;
  state: VoiceCallState;
}

interface StartingCall {
  kind: "starting";
  callId: string;
  controller: AbortController;
  completion: Promise<void>;
}

interface ActiveCallLifecycle {
  kind: "active";
  call: ActiveCall;
}

interface StoppingCall {
  kind: "stopping";
  call: ActiveCall;
  completion: Promise<void>;
}

type CallLifecycle = { kind: "idle" } | StartingCall | ActiveCallLifecycle | StoppingCall;

export function createVoiceChat(options: CreateVoiceChatOptions): VoiceChat {
  const clients = new Set<VoiceChatClientSession>();

  function openClientSession(input: {
    emit(message: VoiceCallOutboundMessage): void;
  }): VoiceChatClientSession {
    const client = createClientSession({ options, input });
    clients.add(client);
    return {
      handle: client.handle,
      disconnect: client.disconnect,
      async close() {
        clients.delete(client);
        await client.close();
      },
    };
  }

  return {
    openClientSession,
    async close() {
      const activeClients = [...clients];
      clients.clear();
      await Promise.all(activeClients.map((client) => client.close()));
    },
  };
}

function createClientSession(params: {
  options: CreateVoiceChatOptions;
  input: {
    emit(message: VoiceCallOutboundMessage): void;
  };
}): VoiceChatClientSession {
  const { options, input } = params;
  let lifecycle: CallLifecycle = { kind: "idle" };

  function isCurrentCall(call: ActiveCall): boolean {
    return lifecycle.kind === "active" && lifecycle.call === call;
  }

  function emitState(call: ActiveCall, patch: Partial<VoiceCallState>): void {
    call.state = { ...call.state, ...patch };
    input.emit({ type: "voice.call.state", payload: call.state });
  }

  function emitProviderOutput(call: ActiveCall, output: VoiceProviderOutput): void {
    if (!isCurrentCall(call)) return;
    if (output.type === "state") {
      emitState(call, {
        ...(output.input ? { input: output.input } : {}),
        ...(output.error !== undefined ? { error: output.error } : {}),
      });
      return;
    }
    if (output.type === "event") {
      input.emit({
        type: "voice.call.event",
        payload: { callId: call.callId, event: output.event },
      });
      return;
    }
    input.emit({
      type: "voice.call.transport.server",
      payload: { callId: call.callId, data: output.data },
    });
  }

  function emitStartRejected(requestId: string, error: string): void {
    input.emit({
      type: "voice.call.start.response",
      payload: { requestId, accepted: false, callId: null, error },
    });
  }

  function validateStart(
    message: Extract<VoiceCallInboundMessage, { type: "voice.call.start.request" }>,
  ): { provider: VoiceCallProvider; transportOffers: VoiceCallTransportOffer[] } | null {
    if (lifecycle.kind !== "idle") {
      emitStartRejected(message.requestId, "A voice call is already active.");
      return null;
    }
    const provider = options.provider;
    if (!provider) {
      emitStartRejected(message.requestId, "Configure a voice call provider to use voice chat.");
      return null;
    }
    const readiness = provider.getReadiness();
    if (!readiness.ready) {
      emitStartRejected(message.requestId, readiness.reason);
      return null;
    }
    if (!message.transports || message.transports.length === 0) {
      emitStartRejected(message.requestId, UPDATE_APP_MESSAGE);
      return null;
    }
    return { provider, transportOffers: message.transports };
  }

  async function finishStart(inputParams: {
    provider: VoiceCallProvider;
    transportOffers: VoiceCallTransportOffer[];
    message: Extract<VoiceCallInboundMessage, { type: "voice.call.start.request" }>;
    starting: StartingCall;
  }): Promise<void> {
    const { provider, transportOffers, message, starting } = inputParams;
    const pendingOutputs: VoiceProviderOutput[] = [];
    let call: ActiveCall | null = null;
    try {
      const providerCall = await provider.start({
        callId: starting.callId,
        context: message.context,
        transportOffers,
        signal: starting.controller.signal,
        emit(output) {
          if (call) emitProviderOutput(call, output);
          else pendingOutputs.push(output);
        },
      });
      const selectedWasOffered = transportOffers.some(
        (offer) => offer.kind === providerCall.transport.kind,
      );
      const startWasCanceled = starting.controller.signal.aborted || lifecycle !== starting;
      if (!selectedWasOffered || startWasCanceled) {
        await providerCall.stop();
        if (!selectedWasOffered) {
          throw new Error(
            `Voice provider selected an unoffered '${providerCall.transport.kind}' transport`,
          );
        }
        throw new Error("Voice call start was canceled.");
      }

      call = {
        callId: starting.callId,
        context: message.context,
        providerCall,
        state: {
          callId: starting.callId,
          lifecycle: "active",
          input: "idle",
          error: null,
        },
      };
      lifecycle = { kind: "active", call };
      input.emit({
        type: "voice.call.start.response",
        payload: {
          requestId: message.requestId,
          accepted: true,
          callId: call.callId,
          transport: providerCall.transport,
          error: null,
        },
      });
      input.emit({ type: "voice.call.state", payload: call.state });
      for (const output of pendingOutputs) emitProviderOutput(call, output);
      watchProviderTerminal(call);
    } catch (error) {
      if (lifecycle === starting) lifecycle = { kind: "idle" };
      emitStartRejected(message.requestId, getErrorMessage(error));
    }
  }

  async function start(
    message: Extract<VoiceCallInboundMessage, { type: "voice.call.start.request" }>,
  ): Promise<void> {
    const validated = validateStart(message);
    if (!validated) return;
    const starting: StartingCall = {
      kind: "starting",
      callId: uuidv4(),
      controller: new AbortController(),
      completion: Promise.resolve(),
    };
    lifecycle = starting;
    starting.completion = finishStart({ ...validated, message, starting });
    await starting.completion;
  }

  function watchProviderTerminal(call: ActiveCall): void {
    void call.providerCall.closed.then(
      (terminal) => finishProviderTerminal(call, terminal),
      (error) => finishProviderTerminal(call, { type: "failed", error: getErrorMessage(error) }),
    );
  }

  async function finishProviderTerminal(
    call: ActiveCall,
    terminal: VoiceProviderTerminal,
  ): Promise<void> {
    if (lifecycle.kind !== "active" || lifecycle.call !== call) return;
    const completion = Promise.resolve().then(async () => {
      try {
        await call.providerCall.stop();
      } catch (error) {
        terminal = { type: "failed", error: getErrorMessage(error) };
      }
      finishStoppedCall(call, terminal);
      return undefined;
    });
    lifecycle = { kind: "stopping", call, completion };
    await completion;
  }

  async function stopCurrentCall(): Promise<void> {
    if (lifecycle.kind === "idle") return;
    if (lifecycle.kind === "starting") {
      const starting = lifecycle;
      starting.controller.abort();
      await starting.completion;
      return;
    }
    if (lifecycle.kind === "stopping") {
      await lifecycle.completion;
      return;
    }
    const { call } = lifecycle;
    const completion = Promise.resolve().then(async () => {
      let terminal: VoiceProviderTerminal = { type: "closed" };
      try {
        await call.providerCall.stop();
      } catch (error) {
        terminal = { type: "failed", error: getErrorMessage(error) };
      }
      finishStoppedCall(call, terminal);
      return undefined;
    });
    lifecycle = { kind: "stopping", call, completion };
    await completion;
  }

  function finishStoppedCall(call: ActiveCall, terminal: VoiceProviderTerminal): void {
    if (lifecycle.kind !== "stopping" || lifecycle.call !== call) return;
    lifecycle = { kind: "idle" };
    emitState(
      call,
      terminal.type === "failed"
        ? { lifecycle: "failed", input: "idle", error: terminal.error }
        : { lifecycle: "ended", input: "idle", error: null },
    );
  }

  function activeCallFor(message: VoiceCallInboundMessage): ActiveCall | null {
    if (!("callId" in message)) return null;
    if (lifecycle.kind !== "active" || lifecycle.call.callId !== message.callId) return null;
    return lifecycle.call;
  }

  async function handle(message: VoiceCallInboundMessage): Promise<void> {
    if (message.type === "voice.call.start.request") {
      await start(message);
      return;
    }
    const call = activeCallFor(message);
    if (!call) {
      emitInactiveCallResponse(message);
      return;
    }
    if (message.type === "voice.call.transport.client") {
      await call.providerCall.handleTransportMessage(message.data);
      return;
    }
    if (message.type === "voice.call.context.update.request") {
      try {
        await call.providerCall.updateContext(message.context);
        call.context = message.context;
        input.emit({
          type: "voice.call.context.update.response",
          payload: {
            requestId: message.requestId,
            callId: call.callId,
            accepted: true,
            error: null,
          },
        });
      } catch (error) {
        input.emit({
          type: "voice.call.context.update.response",
          payload: {
            requestId: message.requestId,
            callId: call.callId,
            accepted: false,
            error: getErrorMessage(error),
          },
        });
      }
      return;
    }
    try {
      await stopCurrentCall();
      input.emit({
        type: "voice.call.stop.response",
        payload: {
          requestId: message.requestId,
          callId: message.callId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      input.emit({
        type: "voice.call.stop.response",
        payload: {
          requestId: message.requestId,
          callId: message.callId,
          accepted: false,
          error: getErrorMessage(error),
        },
      });
    }
  }

  function emitInactiveCallResponse(message: VoiceCallInboundMessage): void {
    if (message.type === "voice.call.stop.request") {
      input.emit({
        type: "voice.call.stop.response",
        payload: {
          requestId: message.requestId,
          callId: message.callId,
          accepted: false,
          error: CALL_ENDED_MESSAGE,
        },
      });
    }
    if (message.type === "voice.call.context.update.request") {
      input.emit({
        type: "voice.call.context.update.response",
        payload: {
          requestId: message.requestId,
          callId: message.callId,
          accepted: false,
          error: CALL_ENDED_MESSAGE,
        },
      });
    }
  }

  return { handle, disconnect: stopCurrentCall, close: stopCurrentCall };
}

export function rejectLegacyVoiceMode(input: {
  requestId: string | undefined;
  emit(message: SessionOutboundMessage): void;
}): void {
  if (!input.requestId) return;
  input.emit({
    type: "set_voice_mode_response",
    payload: {
      requestId: input.requestId,
      enabled: false,
      agentId: null,
      accepted: false,
      error: UPDATE_APP_MESSAGE,
    },
  });
}
