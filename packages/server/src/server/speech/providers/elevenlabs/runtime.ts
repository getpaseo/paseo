import type { Logger } from "pino";

import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { TurnDetectionProvider } from "../../turn-detection-provider.js";
import { ElevenLabsTTS, type ElevenLabsTtsConfig } from "./tts.js";

export interface ElevenLabsSpeechAvailability {
  tts: boolean;
}

interface ExistingSpeechServices {
  turnDetectionService: TurnDetectionProvider | null;
  sttService: SpeechToTextProvider | null;
  ttsService: TextToSpeechProvider | null;
  dictationSttService: SpeechToTextProvider | null;
}

export function getElevenLabsSpeechAvailability(
  elevenlabsConfig: ElevenLabsTtsConfig | undefined,
): ElevenLabsSpeechAvailability {
  return {
    tts: Boolean(elevenlabsConfig?.apiKey && elevenlabsConfig.voiceId),
  };
}

export function validateElevenLabsCredentialRequirements(params: {
  providers: RequestedSpeechProviders;
  elevenlabsConfig: ElevenLabsTtsConfig | undefined;
  logger: Logger;
}): void {
  const { providers, logger, elevenlabsConfig } = params;
  const hasTts = Boolean(elevenlabsConfig?.apiKey && elevenlabsConfig.voiceId);

  const missingFor: string[] = [];
  if (providers.voiceStt.enabled !== false && providers.voiceStt.provider === "elevenlabs") {
    missingFor.push("voice.stt (ElevenLabs is TTS-only)");
  }
  if (
    providers.dictationStt.enabled !== false &&
    providers.dictationStt.provider === "elevenlabs"
  ) {
    missingFor.push("dictation.stt (ElevenLabs is TTS-only)");
  }
  if (
    providers.voiceTurnDetection.enabled !== false &&
    providers.voiceTurnDetection.provider === "elevenlabs"
  ) {
    missingFor.push("voice.turnDetection (ElevenLabs is TTS-only)");
  }
  if (providers.voiceTts.enabled !== false && providers.voiceTts.provider === "elevenlabs") {
    if (!hasTts) {
      missingFor.push("voice.tts (ElevenLabs TTS requires apiKey + voiceId)");
    }
  }

  if (missingFor.length > 0) {
    logger.warn(
      {
        requestedProviders: {
          dictationStt: providers.dictationStt.provider,
          voiceStt: providers.voiceStt.provider,
          voiceTurnDetection: providers.voiceTurnDetection.provider,
          voiceTts: providers.voiceTts.provider,
        },
        missingFor,
      },
      "Invalid speech configuration: ElevenLabs provider selected but cannot satisfy requested feature — speech features will be unavailable",
    );
  }
}

export function initializeElevenLabsSpeechServices(params: {
  providers: RequestedSpeechProviders;
  elevenlabsConfig: ElevenLabsTtsConfig | undefined;
  existing: ExistingSpeechServices;
  logger: Logger;
}): ExistingSpeechServices {
  const { providers, elevenlabsConfig, existing, logger } = params;
  const hasTts = Boolean(elevenlabsConfig?.apiKey && elevenlabsConfig.voiceId);
  const needsTts =
    !existing.ttsService &&
    providers.voiceTts.enabled !== false &&
    providers.voiceTts.provider === "elevenlabs";

  if (needsTts && hasTts && elevenlabsConfig) {
    logger.info("ElevenLabs speech provider initialized");
    return {
      turnDetectionService: existing.turnDetectionService,
      sttService: existing.sttService,
      ttsService: new ElevenLabsTTS(elevenlabsConfig, logger),
      dictationSttService: existing.dictationSttService,
    };
  }

  return existing;
}
