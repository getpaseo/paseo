<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo</h1>

<p align="center">Manage coding agents from your phone and desktop.</p>

---

> [!WARNING]
> **Early development** — Features may break or change without notice. Use at your own risk.

Paseo is a self-hosted daemon for Claude Code, Codex, and OpenCode. Agents run on your machine with your full dev environment. Connect from phone, desktop, or web.

## Features

- **Self-hosted:** The daemon runs on your laptop, home server, or VPS
- **Multi-provider:** Works with Claude Code, Codex, and OpenCode from one interface
- **Multi-host:** Connect to multiple daemons and see all your agents in one place
- **Voice input:** Dictate prompts when you're away from your keyboard
- **Optional relay:** Use the hosted end-to-end encrypted relay, or connect directly
- **Cross-device:** iOS, Android, desktop, web, and CLI
- **Git integration:** Manage agents in isolated worktrees, review diffs, ship from the app
- **Open source:** Free and open source under MIT license

## Quick Start

```bash
npm install -g @getpaseo/cli && paseo
```

Then open the app and connect to your daemon.

## Local speech (STT/TTS)

Paseo can run dictation + voice mode STT/TTS fully locally via `sherpa-onnx`.

When the daemon starts with a local speech provider selected, it will download any missing model files automatically (unless `PASEO_SHERPA_ONNX_AUTO_DOWNLOAD=0`).

```bash
npm run speech:download --workspace=@getpaseo/server
```

Optional configuration:

- `PASEO_SHERPA_ONNX_MODELS_DIR` (defaults to `~/.paseo/models/sherpa-onnx`)
- `PASEO_SHERPA_ONNX_AUTO_DOWNLOAD` (`1` by default; set `0` to disable automatic downloads on daemon start)
- `PASEO_SHERPA_STT_PRESET` (`zipformer`, `paraformer`, or `parakeet` for NVIDIA Parakeet TDT v3)
- `PASEO_SHERPA_TTS_PRESET` (`pocket-tts` (Kyutai Pocket TTS), `kitten`, or `kokoro`)
- `PASEO_DICTATION_STT_PROVIDER`, `PASEO_VOICE_STT_PROVIDER`, `PASEO_VOICE_TTS_PROVIDER` (`sherpa` or `openai`)

To see all supported local model IDs:

```bash
npm run speech:models --workspace=@getpaseo/server
```

Optional: run an end-to-end test that downloads real models and exercises streaming STT + streaming TTS:

```bash
PASEO_SPEECH_E2E_DOWNLOAD=1 PASEO_SPEECH_E2E_MODEL_SET=parakeet-pocket \
  npx vitest run --workspace=@getpaseo/server src/server/speech/sherpa/speech-download.e2e.test.ts
```

## Documentation

See [paseo.sh/docs](https://paseo.sh/docs) for full documentation.

## Desktop releases

Desktop app binaries are built and attached to a GitHub Release when you push a version tag (for example `v0.1.0` or `desktop-v0.1.0`).

```bash
git tag v0.1.0
git push origin v0.1.0
```

If you prefer, `npm version` can be used to create and push a version tag.

This triggers the `Desktop Release` workflow (`.github/workflows/desktop-release.yml`).

## License

MIT
