import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/')({
  head: () => ({
    meta: [
      { title: 'Getting Started - Paseo Docs' },
      {
        name: 'description',
        content: 'Learn how to set up and use Paseo to manage your coding agents from anywhere.',
      },
    ],
  }),
  component: GettingStarted,
})

function GettingStarted() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-medium font-serif mb-4">Getting Started</h1>
        <p className="text-white/60 leading-relaxed">
          Paseo connects to your local development environment and lets you manage your coding agents from anywhere.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Installation</h2>
        <p className="text-white/60">
          Install the server globally and run it on your machine:
        </p>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span className="text-muted-foreground select-none">$ </span>
          <span>npm install -g @paseohq/server</span>
        </div>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span className="text-muted-foreground select-none">$ </span>
          <span>paseo</span>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Connect the App</h2>
        <p className="text-white/60">
          Open Paseo on your phone and scan the QR code displayed in your terminal, or enter the server address manually.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Prerequisites</h2>
        <p className="text-white/60">
          Paseo wraps CLI tools like Claude Code and Codex. You'll need to have them installed and configured with your own credentials before Paseo can manage them.
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <a
              href="https://docs.anthropic.com/en/docs/claude-code"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/80"
            >
              Claude Code
            </a>
          </li>
          <li>
            <a
              href="https://github.com/openai/codex"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/80"
            >
              Codex
            </a>
          </li>
          <li>
            <a
              href="https://github.com/opencode-ai/opencode"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/80"
            >
              OpenCode
            </a>
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Voice Setup</h2>
        <p className="text-white/60">
          Voice features currently require an OpenAI API key. Set it as an environment variable before running the server:
        </p>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span className="text-muted-foreground select-none">$ </span>
          <span>export OPENAI_API_KEY=your-key-here</span>
        </div>
        <p className="text-white/60">
          Local voice support is coming soon.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Next</h2>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <a href="/docs/configuration" className="underline hover:text-white/80">
              Configuration
            </a>
          </li>
          <li>
            <a href="/docs/security" className="underline hover:text-white/80">
              Security
            </a>
          </li>
        </ul>
      </section>
    </div>
  )
}
