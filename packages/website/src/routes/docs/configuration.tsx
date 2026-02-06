import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/configuration')({
  head: () => ({
    meta: [
      { title: 'Configuration - Paseo Docs' },
      {
        name: 'description',
        content: 'Configure Paseo via config.json, environment variables, and CLI overrides.',
      },
    ],
  }),
  component: Configuration,
})

function Configuration() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-medium font-title mb-4">Configuration</h1>
        <p className="text-white/60 leading-relaxed">
          Paseo loads configuration from a single JSON file in your Paseo home directory, with optional
          environment variable and CLI overrides.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Where config lives</h2>
        <p className="text-white/60 leading-relaxed">
          By default, Paseo uses <code className="font-mono">~/.paseo</code> as its home directory.
          The configuration file is:
        </p>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span className="text-muted-foreground select-none">$ </span>
          <span>~/.paseo/config.json</span>
        </div>
        <p className="text-white/60 leading-relaxed">
          You can change the home directory by setting <code className="font-mono">PASEO_HOME</code>{' '}
          or passing <code className="font-mono">--home</code> to <code className="font-mono">paseo daemon start</code>.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Precedence</h2>
        <p className="text-white/60 leading-relaxed">
          Paseo merges configuration in this order:
        </p>
        <ol className="text-white/60 space-y-2 list-decimal list-inside">
          <li>Defaults</li>
          <li><code className="font-mono">config.json</code></li>
          <li>Environment variables</li>
          <li>CLI flags</li>
        </ol>
        <p className="text-white/60 leading-relaxed">
          Lists append across sources (for example, <code className="font-mono">allowedHosts</code> and
          <code className="font-mono">cors.allowedOrigins</code>).
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Example</h2>
        <p className="text-white/60 leading-relaxed">
          Minimal example that configures listening address, host allowlist, provider keys, and MCP:
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
{`{
  "$schema": "https://paseo.sh/schemas/paseo.config.v1.json",
  "version": 1,
  "providers": {
    "openai": { "apiKey": "..." }
  },
  "daemon": {
    "listen": "127.0.0.1:6767",
    "allowedHosts": ["localhost", ".localhost"],
    "mcp": { "enabled": true }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Voice</h2>
        <p className="text-white/60 leading-relaxed">
          Voice is provider-based per feature: dictation STT, realtime voice STT, and voice TTS can each
          use <code className="font-mono">local</code> or <code className="font-mono">openai</code>.
          Defaults are local for all three.
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
{`{
  "version": 1,
  "features": {
    "dictation": { "stt": { "provider": "local" } },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local" },
      "tts": { "provider": "local" }
    }
  },
  "providers": {
    "sherpaOnnx": {
      "modelsDir": "~/.paseo/models/sherpa-onnx",
      "autoDownload": true,
      "stt": { "preset": "parakeet-tdt-0.6b-v3-int8" },
      "tts": { "preset": "pocket-tts-onnx-int8" }
    }
  }
}`}
        </pre>
        <p className="text-white/60 leading-relaxed">
          Voice LLM orchestration is agents-only. Set{' '}
          <code className="font-mono">features.voiceMode.llm.provider</code> to one of{' '}
          <code className="font-mono">claude</code>, <code className="font-mono">codex</code>, or{' '}
          <code className="font-mono">opencode</code>. If set, startup is strict and fails if unavailable.
          If omitted, Paseo picks the first available voice-enabled agent provider.
        </p>
        <p className="text-white/60 leading-relaxed">
          Local voice uses ONNX models (sherpa-onnx + PocketTTS). Default presets are
          <code className="font-mono">parakeet-tdt-0.6b-v3-int8</code> for STT and
          <code className="font-mono">pocket-tts-onnx-int8</code> for TTS.
        </p>
        <p className="text-white/60 leading-relaxed">
          With local provider enabled and auto-download on (default outside tests), missing model files are
          downloaded at daemon startup into <code className="font-mono">$PASEO_HOME/models/sherpa-onnx</code>.
          Downloads are only performed for missing files.
        </p>
        <p className="text-white/60 leading-relaxed">
          Local ONNX execution is CPU-first by default. It works without GPU requirements, but performance
          depends on your machine.
        </p>
        <p className="text-white/60 leading-relaxed">
          To force OpenAI for voice/dictation, configure OpenAI providers explicitly and provide
          <code className="font-mono">OPENAI_API_KEY</code>. If OpenAI is selected but credentials are
          missing, daemon startup fails fast.
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
{`{
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
}`}
        </pre>
        <p className="text-white/60 leading-relaxed">
          Realtime voice can create/manage coding agents. Use clear prompts and explicit paths, because
          those agents can be launched in arbitrary working directories by request.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Common env vars</h2>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li><code className="font-mono">PASEO_HOME</code> — set Paseo home directory</li>
          <li><code className="font-mono">PASEO_LISTEN</code> — override <code className="font-mono">daemon.listen</code></li>
          <li><code className="font-mono">PASEO_ALLOWED_HOSTS</code> — override/extend <code className="font-mono">daemon.allowedHosts</code></li>
          <li><code className="font-mono">OPENAI_API_KEY</code> — override OpenAI provider key</li>
          <li><code className="font-mono">PASEO_VOICE_LLM_PROVIDER</code> — override voice LLM provider (<code className="font-mono">claude</code>, <code className="font-mono">codex</code>, <code className="font-mono">opencode</code>)</li>
          <li><code className="font-mono">PASEO_DICTATION_STT_PROVIDER</code>, <code className="font-mono">PASEO_VOICE_STT_PROVIDER</code>, <code className="font-mono">PASEO_VOICE_TTS_PROVIDER</code> — override voice provider selection (<code className="font-mono">local</code> or <code className="font-mono">openai</code>)</li>
          <li><code className="font-mono">PASEO_SHERPA_ONNX_MODELS_DIR</code> and <code className="font-mono">PASEO_SHERPA_ONNX_AUTO_DOWNLOAD</code> — control local model directory and download behavior</li>
          <li><code className="font-mono">PASEO_SHERPA_STT_PRESET</code> and <code className="font-mono">PASEO_SHERPA_TTS_PRESET</code> — override local STT/TTS model presets</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Schema</h2>
        <p className="text-white/60 leading-relaxed">
          For editor autocomplete/validation, set <code className="font-mono">$schema</code> to:
        </p>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span>https://paseo.sh/schemas/paseo.config.v1.json</span>
        </div>
      </section>
    </div>
  )
}
