import type {
  VoiceAppContext,
  VoiceCallEvent,
  VoiceCallTransport,
  VoiceCallTransportOffer,
} from "@getpaseo/protocol/messages";

export type VoiceProviderReadiness = { ready: true } | { ready: false; reason: string };

export type VoiceProviderOutput =
  | {
      type: "state";
      input?: "idle" | "listening" | "speech_detected";
      error?: string | null;
    }
  | { type: "event"; event: VoiceCallEvent }
  | { type: "transport"; data: unknown };

export type VoiceProviderTerminal = { type: "closed" } | { type: "failed"; error: string };

export interface VoiceProviderCall {
  readonly transport: VoiceCallTransport;
  readonly closed: Promise<VoiceProviderTerminal>;
  updateContext(context: VoiceAppContext): Promise<void>;
  handleTransportMessage(data: unknown): Promise<void>;
  stop(): Promise<void>;
}

export interface VoiceProviderStartInput {
  callId: string;
  context: VoiceAppContext;
  transportOffers: readonly VoiceCallTransportOffer[];
  signal: AbortSignal;
  emit(output: VoiceProviderOutput): void;
}

export interface VoiceCallProvider {
  getReadiness(): VoiceProviderReadiness;
  start(input: VoiceProviderStartInput): Promise<VoiceProviderCall>;
}
