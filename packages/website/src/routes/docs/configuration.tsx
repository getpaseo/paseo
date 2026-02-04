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
        <h1 className="text-3xl font-medium font-serif mb-4">Configuration</h1>
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
  "$schema": "https://paseo.dev/schemas/paseo.config.v1.json",
  "version": 1,
  "providers": {
    "openai": { "apiKey": "..." },
    "openrouter": { "apiKey": "..." }
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
        <h2 className="text-xl font-medium">Common env vars</h2>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li><code className="font-mono">PASEO_HOME</code> — set Paseo home directory</li>
          <li><code className="font-mono">PASEO_LISTEN</code> — override <code className="font-mono">daemon.listen</code></li>
          <li><code className="font-mono">PASEO_ALLOWED_HOSTS</code> — override/extend <code className="font-mono">daemon.allowedHosts</code></li>
          <li><code className="font-mono">OPENAI_API_KEY</code> and <code className="font-mono">OPENROUTER_API_KEY</code> — override provider keys</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Schema</h2>
        <p className="text-white/60 leading-relaxed">
          For editor autocomplete/validation, set <code className="font-mono">$schema</code> to:
        </p>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span>https://paseo.dev/schemas/paseo.config.v1.json</span>
        </div>
      </section>
    </div>
  )
}

