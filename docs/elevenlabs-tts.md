# ElevenLabs TTS Provider

Paseo can route the realtime-voice text-to-speech slot to ElevenLabs in
addition to the built-in OpenAI and local (sherpa) providers. ElevenLabs
is the recommended pick when you want higher-fidelity voices than
OpenAI's stock set or access to a voice you cloned in the ElevenLabs
console.

ElevenLabs is **TTS-only**. STT and turn-detection slots ignore
`provider: "elevenlabs"` — keep using `local` or `openai` for those
features.

## Configuration

Pick one of two sources. Persisted config wins when both are set for
the same field.

### Environment variables

```
ELEVENLABS_API_KEY=...                    # required
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM  # required, an ElevenLabs voice_id
ELEVENLABS_BASE_URL=https://api.elevenlabs.io    # optional, default shown
ELEVENLABS_TTS_MODEL=eleven_multilingual_v2      # optional, default shown
```

`ELEVENLABS_TTS_VOICE_ID` is accepted as an alias for `ELEVENLABS_VOICE_ID`
for symmetry with the OpenAI `TTS_VOICE` naming.

### Persisted config (`$PASEO_HOME/config.json`)

```jsonc
{
  "providers": {
    "elevenlabs": {
      "apiKey": "...",
      "voiceId": "21m00Tcm4TlvDq8ikWAM",
      "modelId": "eleven_multilingual_v2",
      "baseUrl": "https://api.elevenlabs.io",
    },
  },
  "features": {
    "voiceMode": {
      "tts": { "provider": "elevenlabs" },
    },
  },
}
```

All fields under `providers.elevenlabs` are optional except `apiKey`
and `voiceId`. If either is missing, the provider stays inactive and
the runtime falls back to whatever other providers are configured for
the TTS slot.

## Defaults

| Field           | Default                     | Notes                                     |
| --------------- | --------------------------- | ----------------------------------------- |
| `baseUrl`       | `https://api.elevenlabs.io` | Override only for proxies or self-hosted. |
| `modelId`       | `eleven_multilingual_v2`    | Best general-purpose multilingual model.  |
| `output_format` | `mp3_44100_128`             | Sent as the `output_format` query param.  |

The provider returns the synthesized audio tagged as `format: "mp3"`,
which the client maps to `audio/mpeg`. Both the web and native audio
engines decode MP3 natively, so no extra client work is required.

## How a request flows

1. `resolveElevenLabsSpeechConfig` reads `providers.elevenlabs` first,
   then the env vars, and returns `undefined` if no `apiKey` is set.
2. When `voiceTts.provider === "elevenlabs"` and credentials are
   present, `initializeElevenLabsSpeechServices` instantiates
   `ElevenLabsTTS`.
3. The TTS segment scheduler calls `synthesizeSpeech(text)` per
   segment. Each call POSTs `text` + `model_id` to
   `/v1/text-to-speech/{voiceId}?output_format=...` with the
   `xi-api-key` header.
4. The MP3 response body is piped through the existing `audio_output`
   pipeline. The base64 chunk is delivered to the app with
   `format: "mp3"`; the runtime decodes it and plays it back.

## Capability caveats

| Slot                      | Result with `elevenlabs`                |
| ------------------------- | --------------------------------------- |
| `voiceMode.tts`           | ✅ ElevenLabs voices.                   |
| `voiceMode.stt`           | ⚠️ Logged warning, feature unavailable. |
| `voiceMode.turnDetection` | ⚠️ Logged warning, feature unavailable. |
| `dictation.stt`           | ⚠️ Logged warning, feature unavailable. |

`validateElevenLabsCredentialRequirements` emits a single
`logger.warn` per invalid slot at startup so misconfigurations are
visible in `$PASEO_HOME/daemon.log`.

## Gotchas

**Voice IDs are opaque strings.** ElevenLabs voice IDs look like
`21m00Tcm4TlvDq8ikWAM`. The schema accepts any non-empty trimmed
string, so the resolver will happily route a misspelled ID straight to
the API — a 400 from ElevenLabs surfaces in `daemon.log` rather than at
boot. Pull the canonical ID from the ElevenLabs Voices page.

**Back-compat on `features.voiceMode.tts.voice`.** The persisted-config
schema used to constrain `voice` to the OpenAI enum
(`alloy | echo | fable | onyx | nova | shimmer`). ElevenLabs voice IDs
aren't in that enum, so the schema was widened to `string` for the
`voice` field. Every prior value still parses — existing OpenAI
configs are unaffected.

**Provider-id in readiness snapshots.** `voiceTts` reports
`"elevenlabs"` when the active TTS provider is ElevenLabs. The label
function (`resolveVoiceTtsLabel`) uses identity comparison against the
TTS instance, matching how it handles the local provider.

**Cost & latency.** ElevenLabs adds a network round trip per segment
and charges per character. The TTS segment scheduler already prefetches
`TTS_PREFETCH_SEGMENTS = 2` ahead of playback, which is usually enough
to keep the lead-in under a second on a healthy connection. Cold paths
on the first segment will surface as a startup delay, not a stall.

**No SDK dependency.** The implementation calls `/v1/text-to-speech`
directly with `fetch` — no `elevenlabs` npm package — to avoid pulling
a runtime dep for a single endpoint.

## Tests

`packages/server/src/server/speech/providers/elevenlabs/` ships
collocated unit tests:

- `tts.test.ts` — URL building (including URL-encoding voice IDs with
  slashes), request shape, empty-input rejection, error mapping from
  non-2xx responses.
- `runtime.test.ts` — availability, credential wiring, slot fallback,
  validation no-op when configuration is consistent.

Run them with:

```
npx vitest run packages/server/src/server/speech/providers/elevenlabs
```

The full speech test suite (41 tests) stays green.
