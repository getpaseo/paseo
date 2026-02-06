import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/voice')({
  head: () => ({
    meta: [
      { title: 'Voice - Paseo Docs' },
      {
        name: 'description',
        content: 'Paseo voice architecture, local-first model execution, and provider configuration.',
      },
    ],
  }),
  component: VoiceDocs,
})

function VoiceDocs() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-medium font-title mb-4">Voice</h1>
        <p className="text-white/60 leading-relaxed">
          Paseo has first-class voice support for dictation and realtime conversations with your coding
          environment.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Philosophy</h2>
        <p className="text-white/60 leading-relaxed">
          Voice is local-first. You can run speech fully on-device, or choose OpenAI for speech features.
          For voice reasoning/orchestration, Paseo reuses agent providers already installed and authenticated
          on your machine.
        </p>
        <p className="text-white/60 leading-relaxed">
          This keeps credentials and execution in your environment and avoids introducing a separate
          cloud-only voice stack.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Architecture</h2>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>Speech I/O: STT and TTS providers per feature (<code className="font-mono">local</code> or <code className="font-mono">openai</code>)</li>
          <li>Local speech runtime: ONNX models executed on CPU by default</li>
          <li>Voice LLM orchestration: hidden agent session using your configured provider (<code className="font-mono">claude</code>, <code className="font-mono">codex</code>, or <code className="font-mono">opencode</code>)</li>
          <li>Tooling path: MCP stdio bridge for voice tools and agent control</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Local Speech</h2>
        <p className="text-white/60 leading-relaxed">
          Local speech defaults to model IDs <code className="font-mono">parakeet-tdt-0.6b-v3-int8</code>{' '}
          (STT) and <code className="font-mono">pocket-tts-onnx-int8</code> (TTS).
        </p>
        <p className="text-white/60 leading-relaxed">
          Missing models are downloaded at daemon startup into{' '}
          <code className="font-mono">$PASEO_HOME/models/local-speech</code> when auto-download is enabled.
          Downloads happen only for missing files.
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
{`{
  "version": 1,
  "features": {
    "dictation": { "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v3-int8" } },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v3-int8" },
      "tts": { "provider": "local", "model": "pocket-tts-onnx-int8" }
    }
  },
  "providers": {
    "local": {
      "modelsDir": "~/.paseo/models/local-speech",
      "autoDownload": true
    }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">OpenAI Speech Option</h2>
        <p className="text-white/60 leading-relaxed">
          You can switch dictation, voice STT, and voice TTS to OpenAI by setting provider fields to{' '}
          <code className="font-mono">openai</code> and providing <code className="font-mono">OPENAI_API_KEY</code>.
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
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Environment Variables</h2>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li><code className="font-mono">OPENAI_API_KEY</code> — OpenAI speech credentials</li>
          <li><code className="font-mono">PASEO_VOICE_LLM_PROVIDER</code> — voice agent provider override</li>
          <li><code className="font-mono">PASEO_LOCAL_MODELS_DIR</code>, <code className="font-mono">PASEO_LOCAL_AUTO_DOWNLOAD</code> — local model storage and download policy</li>
          <li><code className="font-mono">PASEO_DICTATION_LOCAL_STT_MODEL</code> — local dictation STT model ID</li>
          <li><code className="font-mono">PASEO_VOICE_LOCAL_STT_MODEL</code>, <code className="font-mono">PASEO_VOICE_LOCAL_TTS_MODEL</code> — local voice STT/TTS model IDs</li>
          <li><code className="font-mono">PASEO_VOICE_LOCAL_TTS_SPEAKER_ID</code>, <code className="font-mono">PASEO_VOICE_LOCAL_TTS_SPEED</code> — optional local voice TTS tuning</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Operational Notes</h2>
        <p className="text-white/60 leading-relaxed">
          Realtime voice can launch and control agents. Treat voice prompts with the same care as direct
          agent instructions, especially when specifying working directories or destructive operations.
        </p>
      </section>
    </div>
  )
}
