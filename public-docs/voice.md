---
title: Voice
description: Paseo voice architecture, local-first model execution, and provider configuration.
nav: Voice
order: 3
---

# Voice

Paseo has first-class voice support for dictation and realtime conversations with your coding environment.

## Philosophy

Voice is local-first. You can run speech fully on-device, or choose OpenAI for speech features. For voice reasoning/orchestration, Paseo reuses agent providers already installed and authenticated on your machine.

This keeps credentials and execution in your environment and avoids introducing a separate cloud-only voice stack.

## Architecture

- Speech I/O: STT and TTS providers per feature (`local` or `openai`)
- Local speech runtime: ONNX models executed on CPU by default
- Voice LLM orchestration: hidden agent session using your configured provider (`claude`, `codex`, or `opencode`)
- Tooling path: MCP stdio bridge for voice tools and agent control

## Local Speech

Local speech defaults to model IDs `parakeet-tdt-0.6b-v3-int8` (STT) and `kokoro-en-v0_19` (TTS, speaker 0 / voice 00).

Missing models are downloaded at daemon startup into `$PASEO_HOME/models/local-speech`. Downloads happen only for missing files.

```json
{
  "version": 1,
  "features": {
    "dictation": { "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v3-int8" } },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v3-int8" },
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

## OpenAI Speech Option

You can switch dictation, voice STT, and voice TTS to OpenAI by setting provider fields to `openai` and providing `OPENAI_API_KEY`.

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
    "openai": { "apiKey": "..." }
  }
}
```

## Environment Variables

- `OPENAI_API_KEY` — OpenAI speech credentials
- `PASEO_VOICE_LLM_PROVIDER` — voice agent provider override
- `PASEO_LOCAL_MODELS_DIR` — local model storage directory
- `PASEO_DICTATION_LOCAL_STT_MODEL` — local dictation STT model ID
- `PASEO_VOICE_LOCAL_STT_MODEL`, `PASEO_VOICE_LOCAL_TTS_MODEL` — local voice STT/TTS model IDs
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`, `PASEO_VOICE_LOCAL_TTS_SPEED` — optional local voice TTS tuning

## Operational Notes

Realtime voice can launch and control agents. Treat voice prompts with the same care as direct agent instructions, especially when specifying working directories or destructive operations.
