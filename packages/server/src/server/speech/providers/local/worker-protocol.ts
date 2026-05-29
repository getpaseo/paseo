import type {
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  TranscriptionResult,
} from "../../speech-provider.js";

export interface LocalSpeechWorkerConfig {
  modelsDir: string;
  voiceSttModel: string;
  dictationSttModel: string;
  voiceTtsModel: string;
  voiceTtsSpeakerId?: number;
  voiceTtsSpeed?: number;
}

export type LocalSpeechSessionKind = "voiceStt" | "dictationStt" | "vad";

export type LocalSpeechWorkerRequest =
  | {
      type: "tts.synthesize";
      requestId: string;
      config: LocalSpeechWorkerConfig;
      text: string;
    }
  | {
      type: "stt.transcribe";
      requestId: string;
      config: LocalSpeechWorkerConfig;
      model: "voice" | "dictation";
      audio: Buffer;
      format: string;
    }
  | {
      type: "session.create";
      requestId: string;
      config: LocalSpeechWorkerConfig;
      sessionId: string;
      kind: LocalSpeechSessionKind;
    }
  | {
      type: "session.append";
      requestId: string;
      sessionId: string;
      audio: Buffer;
    }
  | {
      type: "session.commit";
      requestId: string;
      sessionId: string;
    }
  | {
      type: "session.clear";
      requestId: string;
      sessionId: string;
    }
  | {
      type: "session.flush";
      requestId: string;
      sessionId: string;
    }
  | {
      type: "session.reset";
      requestId: string;
      sessionId: string;
    }
  | {
      type: "session.close";
      requestId: string;
      sessionId: string;
    };

export type LocalSpeechWorkerResponse =
  | {
      type: "response";
      requestId: string;
      ok: true;
      result?: unknown;
    }
  | {
      type: "response";
      requestId: string;
      ok: false;
      error: string;
    };

export type LocalSpeechWorkerEvent =
  | {
      type: "session.committed";
      sessionId: string;
      payload: StreamingTranscriptionCommittedEvent;
    }
  | {
      type: "session.transcript";
      sessionId: string;
      payload: StreamingTranscriptionEvent;
    }
  | {
      type: "session.speech_started";
      sessionId: string;
    }
  | {
      type: "session.speech_stopped";
      sessionId: string;
    }
  | {
      type: "session.error";
      sessionId: string;
      error: string;
    };

export type LocalSpeechWorkerToParentMessage = LocalSpeechWorkerResponse | LocalSpeechWorkerEvent;

export interface LocalSpeechCreateSessionResult {
  requiredSampleRate: number;
}

export interface LocalSpeechTtsResult {
  audio: Buffer;
  format: string;
}

export type LocalSpeechTranscriptionResult = TranscriptionResult;
