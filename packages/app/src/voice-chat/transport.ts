import type {
  VoiceCallState,
  VoiceCallTransport,
  VoiceCallTransportOffer,
} from "@getpaseo/protocol/messages";

export interface VoiceTransportMediaState {
  isMuted: boolean;
  volume: number;
  output: "idle" | "speaking";
}

export interface VoiceTransportSession {
  sendTransportMessage(callId: string, data: unknown): void;
  setAssistantAudioPlaying(isPlaying: boolean): void;
}

export interface VoiceClientTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleServerMessage(data: unknown): void;
  updateCallState(state: VoiceCallState): void;
  toggleMute(): void;
}

export interface PreparedVoiceClientTransport {
  readonly offer: VoiceCallTransportOffer;
  accepts(answer: VoiceCallTransport): boolean;
  accept(input: {
    callId: string;
    answer: VoiceCallTransport;
    publish(state: VoiceTransportMediaState): void;
  }): Promise<VoiceClientTransport>;
  discard(): Promise<void>;
}

export interface VoiceClientTransportFactory {
  prepare(session: VoiceTransportSession): Promise<PreparedVoiceClientTransport>;
}

export async function acceptVoiceClientTransport(input: {
  prepared: PreparedVoiceClientTransport[];
  callId: string;
  answer: VoiceCallTransport;
  publish(state: VoiceTransportMediaState): void;
}): Promise<VoiceClientTransport> {
  const selected = input.prepared.find((candidate) => candidate.accepts(input.answer));
  if (!selected) {
    await Promise.all(input.prepared.map((candidate) => candidate.discard()));
    throw new Error(`No installed client transport accepted '${input.answer.kind}'`);
  }
  const unselected = input.prepared.filter((candidate) => candidate !== selected);
  const transport = await selected.accept({
    callId: input.callId,
    answer: input.answer,
    publish: input.publish,
  });
  await Promise.all(unselected.map((candidate) => candidate.discard()));
  return transport;
}
