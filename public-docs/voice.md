---
title: Voice
description: Paseo voice architecture, local-first model execution, and provider configuration.
nav: Voice
order: 41
category: Configuration
---

# Voice

Paseo has first-class voice support for dictation and voice mode conversations with your coding environment.

## Philosophy

Voice is local-first. You can run speech fully on-device, or choose OpenAI or Gemini for cloud speech. For voice reasoning/orchestration, Paseo reuses agent providers already installed and authenticated on your machine.

This keeps credentials and execution in your environment and avoids introducing a separate cloud-only voice stack.

## Architecture

- Speech I/O: STT providers per feature and voice TTS providers (`local`, `openai`, or `gemini`)
- Local speech runtime: ONNX models executed on CPU by default
- Voice LLM orchestration: hidden agent session using your configured provider (`claude`, `codex`, or `opencode`)
- Tooling path: MCP stdio bridge for voice tools and agent control

## Local Speech

Local speech defaults to model IDs `parakeet-tdt-0.6b-v2-int8` (STT) and `kokoro-en-v0_19` (TTS, speaker 0 / voice 00).

Missing models are downloaded at daemon startup into `$PASEO_HOME/models/local-speech`. Downloads happen only for missing files.

### Local STT models and language support

| Model ID                    | Languages                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parakeet-tdt-0.6b-v2-int8` | English only (default). Includes punctuation and capitalization.                                                                                                                                                                                                             |
| `parakeet-tdt-0.6b-v3-int8` | 25 European languages, auto-detected: Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian. |

**To use a non-English language, switch the local STT model to `parakeet-tdt-0.6b-v3-int8`.** v3 detects the spoken language automatically — there is no per-language setting for it. The `language` field below does **not** steer the local Parakeet model (v2 is English-only, v3 auto-detects); it applies to cloud STT providers.

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8", "language": "en" }
    },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8", "language": "en" },
      "tts": { "provider": "local", "model": "kokoro-en-v0_19", "speakerId": 0 }
    }
  },
  "providers": {
    "local": {
      "modelsDir": "~/.paseo/models/local-speech"
    }
  }
}
```

For multilingual local dictation, set the model to v3 — it auto-detects the language, so no `language` field is needed:

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v3-int8" }
    }
  }
}
```

The `language` field applies to OpenAI and Gemini STT: set `features.dictation.stt.language` for dictation and `features.voiceMode.stt.language` for voice mode. Gemini detects the language automatically when neither field is set. OpenAI falls back to `en`. The field has no effect on local Parakeet models.

## Gemini Speech

Gemini 3.5 Live Transcribe supports automatic language detection across 85+ languages, incremental transcription, and Smart transcription, which removes filler words, resolves self-corrections, and formats dictated text. Gemini 3.1 Flash TTS provides controllable multilingual speech generation. Select `gemini` independently for dictation STT, voice mode STT, and voice mode TTS. Turn detection remains local.

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "gemini", "mode": "smart" }
    },
    "voiceMode": {
      "stt": { "provider": "gemini", "mode": "smart" },
      "turnDetection": { "provider": "local" },
      "tts": { "provider": "gemini", "voice": "Kore" }
    }
  },
  "providers": {
    "gemini": { "apiKey": "..." }
  }
}
```

Gemini STT defaults to `gemini-3.5-transcribe-live`. Set `features.dictation.stt.model` and `features.voiceMode.stt.model` to use another Live Transcribe model. Set `mode` to `verbatim` to preserve filler words, repetitions, and false starts. Set a BCP-47 `language` such as `zh-CN` only when you want to steer recognition; omit it for automatic detection.

The default TTS model is `gemini-3.1-flash-tts-preview`, with the `Kore` voice. `gemini-2.5-flash-preview-tts` and `gemini-2.5-pro-preview-tts` are also supported; Google offers the Pro model only on its paid tier. Set `features.voiceMode.tts.model` and `features.voiceMode.tts.voice` to select another speech-capable model or [prebuilt voice](https://ai.google.dev/gemini-api/docs/speech-generation#voices). Gemini detects the input text language automatically; STT language hints do not control TTS. Paseo passes configured model and voice names through without maintaining its own allowlist.

Paseo streams mono 16 kHz PCM to Gemini Live Transcribe. Paseo's local turn detector supplies activity boundaries, while Gemini returns partial and final transcripts over the live connection. TTS uses the Interactions API and returns mono 24 kHz PCM audio. Both features use `providers.gemini.apiKey` or `GEMINI_API_KEY`, not the Gemini CLI login configured as an agent provider.

Gemini Live Transcribe connections have a 10-minute maximum duration. Finish a dictation stream within that limit; voice mode reconnects when Google closes a Live session.

## OpenAI Voice Option

You can switch dictation, voice STT, and voice TTS to OpenAI by setting provider fields to `openai` and providing OpenAI credentials.

```json
{
  "version": 1,
  "features": {
    "dictation": { "stt": { "provider": "openai" } },
    "voiceMode": {
      "stt": { "provider": "openai" },
      "tts": { "provider": "openai" }
    }
  },
  "providers": {
    "openai": {
      "stt": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      },
      "tts": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      }
    }
  }
}
```

`providers.openai.stt` covers dictation and voice mode speech-to-text, and `providers.openai.tts` covers voice mode text-to-speech. Because they resolve independently, you can point STT and TTS at different endpoints. Each falls back to `providers.openai.apiKey`/`baseUrl`, then `OPENAI_API_KEY`/`OPENAI_BASE_URL`, when unset. These settings configure only Paseo OpenAI speech traffic, without changing Codex or other OpenAI-backed tools.

Paseo uses these paths under the configured OpenAI base URL:

- dictation STT: `/v1/audio/transcriptions`
- voice mode STT: `/v1/audio/transcriptions`
- voice mode TTS: `/v1/audio/speech`

## Environment Variables

- `PASEO_VOICE_LLM_PROVIDER`, voice agent provider override
- `PASEO_DICTATION_STT_PROVIDER`, `PASEO_VOICE_STT_PROVIDER`, STT provider selection (`local`, `openai`, or `gemini`)
- `PASEO_VOICE_TTS_PROVIDER`, TTS provider selection (`local`, `openai`, or `gemini`)
- `GEMINI_API_KEY`, Gemini API credential for dictation, voice mode STT, and voice mode TTS
- `OPENAI_STT_API_KEY`, `OPENAI_STT_BASE_URL`, OpenAI speech-to-text endpoint (dictation + voice mode STT)
- `OPENAI_TTS_API_KEY`, `OPENAI_TTS_BASE_URL`, OpenAI text-to-speech endpoint (voice mode TTS)
- `PASEO_LOCAL_MODELS_DIR`, local model storage directory
- `PASEO_DICTATION_LOCAL_STT_MODEL`, local dictation STT model ID
- `PASEO_VOICE_LOCAL_STT_MODEL`, `PASEO_VOICE_LOCAL_TTS_MODEL`, local voice STT/TTS model IDs
- `PASEO_DICTATION_LANGUAGE`, dictation STT language hint (OpenAI and Gemini; ignored by local Parakeet)
- `PASEO_VOICE_LANGUAGE`, voice mode STT language hint; falls back to `PASEO_DICTATION_LANGUAGE` when unset (OpenAI and Gemini; ignored by local Parakeet)
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`, `PASEO_VOICE_LOCAL_TTS_SPEED`, optional local voice TTS tuning

## Operational Notes

Voice mode can launch and control agents. Treat voice prompts with the same care as direct agent instructions, especially when specifying working directories or destructive operations.
