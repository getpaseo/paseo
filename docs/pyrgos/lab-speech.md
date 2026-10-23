# Lab speech providers

Voice STT and TTS can run on a local GPU box ("the lab") over WebSocket. When the lab is unreachable, Paseo's stock provider takes over for that turn.

Code: `packages/server/src/server/speech/providers/lab/` (`tts.ts`, `stt.ts`, `config.ts`, `runtime.ts`). The only core change is one call to `applyLabSpeechServices` in `speech-runtime.ts`, after the OpenAI/local services are built. Those services become the fallbacks.

## Environment

| Variable                        | Meaning                                                                                                        | Default                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `PASEO_LAB_TTS_URL`             | `ws(s)://` URL of the lab TTS server. Unset turns lab TTS off.                                                 | unset                                     |
| `PASEO_LAB_STT_URL`             | `ws(s)://` URL of the lab STT server. Unset turns lab STT off.                                                 | unset                                     |
| `PASEO_LAB_TTS_VOICE`           | Voice or saved profile id sent with each `speak`.                                                              | `profile:winner-r6-s49-heart-alice-bella` |
| `PASEO_LAB_CONNECT_TIMEOUT_MS`  | Connect timeout before falling back.                                                                           | `1500`                                    |
| `PASEO_LAB_TTS_IDLE_TIMEOUT_MS` | TTS first-audio and between-frame timeout; before audio it falls back to stock, after audio the stream errors. | `3000`                                    |

Values are never committed. Set them in the daemon's environment.

## Wire protocol

- TTS: client sends `{"type":"speak","text","voice"}`; server streams binary 24 kHz mono int16 PCM, then `{"type":"done","first_audio_ms"}`. `{"type":"cancel"}` stops a running speak; the provider sends it when the consumer closes the stream early. The stream format reported to Paseo is `pcm;rate=24000`.
- STT: client sends binary 16 kHz mono int16 PCM, then `{"type":"end"}` at commit; server sends `partial` messages and one `final`. The session reports `requiredSampleRate = 16000`.

## Fallback rules

- TTS falls back when the connection fails, times out, errors, or closes before the first audio frame. A failure after audio has started destroys the stream (no mid-sentence switch).
- STT falls back when `connect()` cannot reach the lab. Audio is resampled from 16 kHz to the fallback's required rate. A lab that drops mid-utterance surfaces as a session `error`.
- Without a fallback (no stock provider configured), the lab error is thrown.

## Check it

Unit tests use a fake lab server on a loopback ephemeral port:

```
cd packages/server && npx vitest run src/server/speech/providers/lab
```

Headless round trip against a real lab (speaks one sentence, transcribes it back, exits 0 on a match):

```
PASEO_LAB_TTS_URL=... PASEO_LAB_STT_URL=... npx tsx scripts/pyrgos/lab-speech-roundtrip.mts
```

(`.mts` is exempt from the `.sh`/`.ps1` twin rule, like `.mjs`.)
