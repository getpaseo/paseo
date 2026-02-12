import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/privacy')({
  head: () => ({
    meta: [
      { title: 'Privacy Policy - Paseo' },
      {
        name: 'description',
        content:
          'Privacy policy for Paseo - a self-hosted agent manager with no tracking or analytics.',
      },
    ],
  }),
  component: Privacy,
})

function Privacy() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto p-6 md:p-12">
        <h1 className="text-3xl font-medium mb-8">Privacy Policy</h1>

        <div className="space-y-6 text-white/70 leading-relaxed">
          <p>
            Paseo is a self-hosted tool for managing coding agents. Your code and
            data stay on your machine.
          </p>

          <section className="space-y-3">
            <h2 className="text-xl font-medium text-white">What we collect</h2>
            <p>Nothing. Paseo runs on your machine and doesn't send us any data.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-medium text-white">The relay server</h2>
            <p>
              If you use the optional encrypted relay to connect your phone to your
              daemon, the relay sees:
            </p>
            <ul className="list-disc list-inside space-y-1 ml-4">
              <li>IP addresses and connection timing</li>
              <li>Message sizes</li>
              <li>Session IDs</li>
            </ul>
            <p>
              All messages between your phone and daemon are end-to-end encrypted
              with AES-256-GCM. The relay cannot read your messages, see your code,
              or decrypt your traffic.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-medium text-white">Analytics and tracking</h2>
            <p>
              We don't use analytics, tracking pixels, cookies, or ads. The app
              doesn't phone home.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-medium text-white">Third-party services</h2>
            <p>
              Paseo wraps agent providers like Claude Code, Codex, and OpenCode.
              Those tools communicate with their own APIs (Anthropic, OpenAI, etc.)
              using your credentials. Paseo doesn't manage or intercept those API
              calls.
            </p>
            <p>
              If you use voice features with cloud providers (OpenAI speech), your
              voice data is sent to those services according to their privacy
              policies.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-medium text-white">
              We don't sell your data
            </h2>
            <p>
              We don't have your data to sell. Paseo is self-hosted and
              local-first.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-medium text-white">Questions</h2>
            <p>
              If you have questions about privacy, open an issue on{' '}
              <a
                href="https://github.com/getpaseo/paseo"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-white/90"
              >
                GitHub
              </a>
              .
            </p>
          </section>

          <p className="text-sm text-white/50 pt-6">Last updated: February 2025</p>
        </div>
      </div>
    </div>
  )
}
