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

Voice is local-first. You can run speech fully on-device, or choose OpenAI for speech features. For voice reasoning/orchestration, Paseo reuses agent providers already installed and authenticated on your machine.

This keeps credentials and execution in your environment and avoids introducing a separate cloud-only voice stack.

## Architecture

- Speech I/O: STT and TTS providers per feature (`local` or `openai`)
- Local speech runtime: ONNX models executed on CPU by default
- Voice LLM orchestration: hidden agent session using your configured provider (`claude`, `codex`, or `opencode`)
- Tooling path: MCP stdio bridge for voice tools and agent control

## Local Speech

Local speech defaults to model IDs `parakeet-tdt-0.6b-v2-int8` (STT) and `kokoro-en-v0_19` (TTS, speaker 0 / voice 00).

Dictation is on by default. Voice mode is off until you turn it on in **Settings > Voice** or set `features.voiceMode.enabled: true`.

Missing models for enabled features are downloaded at daemon startup into `$PASEO_HOME/models/local-speech`. Downloads happen only for missing files. **Settings > Voice** lists every local model with its size and languages, and lets you download or delete each one.

### Local STT models and language support

**Settings > Voice** lists every local STT model with the languages it supports. The default, `parakeet-tdt-0.6b-v2-int8`, is English-only. For other languages, pick a multilingual model such as `parakeet-tdt-0.6b-v3-int8` (25 European languages) or `whisper-base` (99 languages). The `language` field is passed to STT sessions for both providers. Local recognizers currently detect the spoken language themselves; setting `language` does not expand a model’s supported languages.

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8" }
    },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8" },
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

For multilingual local dictation, set a multilingual model. No `language` field is needed:

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

For either STT provider, set `features.dictation.stt.language` for dictation and `features.voiceMode.stt.language` for voice mode. If voice language is omitted, Paseo uses the dictation language before falling back to `en`.

## OpenAI Voice Option

Set `provider` to `openai` and enter credentials at each use site that needs them.
Dictation, listening and speaking each own their key, base URL and model:

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o-mini-transcribe" }
    },
    "voiceMode": {
      "enabled": true,
      "stt": {
        "provider": "openai",
        "apiKey": "sk-...",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-4o-transcribe",
        "language": "en"
      },
      "tts": { "provider": "openai", "apiKey": "sk-...", "model": "tts-1", "voice": "alloy" }
    }
  }
}
```

| Provider | Speech-to-text fields                                           | Text-to-speech fields                 |
| -------- | --------------------------------------------------------------- | ------------------------------------- |
| `local`  | `model`, `language`                                             | `model`, `speakerId`, `speed`         |
| `openai` | `apiKey`, `baseUrl`, `model`, `language`, `confidenceThreshold` | `apiKey`, `baseUrl`, `model`, `voice` |

Fields other than `provider` are optional. Omit `model` to use the provider's default.
OpenAI model and voice names accept custom IDs from compatible servers. Keys saved
on the host are write-only in the app.

A saved `apiKey` or `baseUrl` wins over env settings. Without a saved value, STT
uses `OPENAI_STT_API_KEY` / `OPENAI_STT_BASE_URL`, TTS uses
`OPENAI_TTS_API_KEY` / `OPENAI_TTS_BASE_URL`, and both fall back to
`OPENAI_API_KEY` / `OPENAI_BASE_URL`. These settings affect Paseo speech traffic.

Existing `providers.openai` settings load automatically into OpenAI use sites that
lack inline values. Endpoint settings take precedence over the old shared settings.
The next save writes the inline shape. A legacy key without an OpenAI site to
receive it is dropped with a warning; enter a key when you later select OpenAI.

Paseo uses these paths under the configured OpenAI base URL:

- dictation STT: `/v1/audio/transcriptions`
- voice mode STT: `/v1/audio/transcriptions`
- voice mode TTS: `/v1/audio/speech`

## Environment Variables

Provider, enablement, model, language, voice and tuning env vars override config.
Keys and base URLs follow the fallback rule above.

- `PASEO_DICTATION_ENABLED`, `PASEO_VOICE_MODE_ENABLED`, feature enablement
- `STT_MODEL`, model override for both OpenAI STT sites
- `STT_CONFIDENCE_THRESHOLD`, confidence threshold for both OpenAI STT sites
- `TTS_MODEL`, `TTS_VOICE`, OpenAI speaking model and voice

- `PASEO_VOICE_LLM_PROVIDER`, voice agent provider override
- `PASEO_DICTATION_STT_PROVIDER`, `PASEO_VOICE_STT_PROVIDER`, `PASEO_VOICE_TTS_PROVIDER`, speech provider selection (`local` or `openai`)
- `OPENAI_STT_API_KEY`, `OPENAI_STT_BASE_URL`, OpenAI speech-to-text endpoint (dictation + voice mode STT)
- `OPENAI_TTS_API_KEY`, `OPENAI_TTS_BASE_URL`, OpenAI text-to-speech endpoint (voice mode TTS)
- `PASEO_LOCAL_MODELS_DIR`, local model storage directory
- `PASEO_DICTATION_LOCAL_STT_MODEL`, local dictation STT model ID
- `PASEO_VOICE_LOCAL_STT_MODEL`, `PASEO_VOICE_LOCAL_TTS_MODEL`, local voice STT/TTS model IDs
- `PASEO_DICTATION_LANGUAGE`, dictation STT language
- `PASEO_VOICE_LANGUAGE`, voice mode STT language; falls back to `PASEO_DICTATION_LANGUAGE` when unset
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`, `PASEO_VOICE_LOCAL_TTS_SPEED`, optional local voice TTS tuning

## Operational Notes

Voice mode can launch and control agents. Treat voice prompts with the same care as direct agent instructions, especially when specifying working directories or destructive operations.
