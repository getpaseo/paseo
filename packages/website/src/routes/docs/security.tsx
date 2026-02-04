import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/security')({
  head: () => ({
    meta: [
      { title: 'Security - Paseo Docs' },
      {
        name: 'description',
        content: 'Security posture for local-first servers: allowedHosts, CORS, and MCP exposure.',
      },
    ],
  }),
  component: Security,
})

function Security() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-medium font-serif mb-4">Security</h1>
        <p className="text-white/60 leading-relaxed">
          Paseo is a local-first server. Most people should keep it bound to localhost and avoid
          exposing it to the public internet.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Host allowlist (DNS rebinding protection)</h2>
        <p className="text-white/60 leading-relaxed">
          <strong className="text-white/80">CORS is not a security boundary.</strong> It controls which browser origins
          can make requests, but it does not prevent a malicious website from resolving to your local machine via DNS rebinding.
        </p>
        <p className="text-white/60 leading-relaxed">
          Paseo uses a Vite-style <code className="font-mono">daemon.allowedHosts</code> allowlist to decide which{' '}
          <code className="font-mono">Host</code> headers the server will respond to.
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>Default (<code className="font-mono">[]</code>): allow <code className="font-mono">localhost</code>, any <code className="font-mono">*.localhost</code>, and all IP addresses</li>
          <li><code className="font-mono">['.example.com']</code>: allow <code className="font-mono">example.com</code> and any subdomain</li>
          <li><code className="font-mono">true</code>: allow any host (not recommended)</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Listen address</h2>
        <p className="text-white/60 leading-relaxed">
          Prefer the default <code className="font-mono">127.0.0.1:6767</code>. If you bind to{' '}
          <code className="font-mono">0.0.0.0</code> or expose the port via tunnels/port-forwarding, review{' '}
          <code className="font-mono">allowedHosts</code> and your network perimeter (firewalls, reverse proxy, auth).
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">MCP exposure</h2>
        <p className="text-white/60 leading-relaxed">
          The Agent MCP HTTP endpoint can be turned off via <code className="font-mono">daemon.mcp.enabled</code> or{' '}
          <code className="font-mono">paseo daemon start --no-mcp</code>.
        </p>
        <p className="text-white/60 leading-relaxed">
          This only affects the HTTP endpoint. Voice mode still uses an in-memory MCP transport internally, so MCP being
          exposed (or not) is orthogonal to voice features.
        </p>
      </section>
    </div>
  )
}

