import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/security')({
  head: () => ({
    meta: [
      { title: 'Security - Paseo Docs' },
      {
        name: 'description',
        content:
          'Security model for Paseo: architecture overview, connection methods, relay encryption, and best practices.',
      },
    ],
  }),
  component: Security,
})

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 text-white/80">
      {children}
    </div>
  )
}

function Security() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-medium font-serif mb-4">Security</h1>
        <p className="text-white/60 leading-relaxed">
          Paseo follows a client-server architecture, similar to Docker. The daemon runs on your
          machine and manages your coding agents. Clients (the mobile app, CLI, or web interface)
          connect to the daemon to monitor and control those agents.
        </p>
        <p className="text-white/60 leading-relaxed mt-3">
          Your code never leaves your machine. Paseo is a local-first tool that connects directly to
          your development environment.
        </p>
      </div>

      {/* Architecture Overview */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Architecture</h2>
        <p className="text-white/60 leading-relaxed">
          The Paseo daemon can run anywhere you want to execute agents: your laptop, a Mac Mini, a
          VPS, or a Docker container. The daemon listens for connections and manages agent
          lifecycles.
        </p>
        <p className="text-white/60 leading-relaxed">
          Clients connect to the daemon over WebSocket. There are two ways to establish this
          connection:
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <strong className="text-white/80">Relay connection (recommended)</strong> — The daemon
            connects outbound to our relay server, and clients meet it there. No open ports
            required.
          </li>
          <li>
            <strong className="text-white/80">Direct connection</strong> — The daemon listens on a
            network address and clients connect directly
          </li>
        </ul>
      </section>

      {/* Relay Connection */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Relay connections (recommended)</h2>
        <p className="text-white/60 leading-relaxed">
          The relay is the simplest way to connect from your phone. It requires no VPN setup, no
          port forwarding, and no firewall configuration. The daemon can stay bound to localhost or
          a socket file — it connects <em>outbound</em> to the relay, and your phone meets it there.
        </p>

        <Callout>
          <strong>The relay is designed to be untrusted.</strong> All traffic between your phone and
          daemon is end-to-end encrypted. The relay server cannot read your messages, see your code,
          or modify traffic without detection. Even if the relay is compromised, your data remains
          protected.
        </Callout>

        <h3 className="text-lg font-medium mt-6">How it works</h3>
        <ol className="text-white/60 space-y-2 list-decimal list-inside">
          <li>
            The daemon generates a persistent ECDH keypair and stores it in{' '}
            <code className="font-mono">$PASEO_HOME/daemon-keypair.json</code>
          </li>
          <li>
            When you scan the QR code or click the pairing link, your phone receives the daemon's
            public key
          </li>
          <li>
            Your phone sends a handshake message with its own public key. The daemon will not accept
            any commands until this handshake completes.
          </li>
          <li>
            Both sides perform an ECDH key exchange to derive a shared secret. All subsequent
            messages are encrypted with AES-256-GCM.
          </li>
        </ol>
        <p className="text-white/60 leading-relaxed mt-3">
          The relay sees only: IP addresses, timing, message sizes, and session IDs. It cannot read
          message contents, forge messages, or derive encryption keys from observing the handshake.
        </p>

        <h3 className="text-lg font-medium mt-6">Why the relay can't attack you</h3>
        <p className="text-white/60 leading-relaxed">
          The daemon requires a valid cryptographic handshake before processing any commands. A
          compromised relay cannot:
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <strong className="text-white/80">Send commands</strong> — Without your phone's private
            key, it cannot complete the handshake
          </li>
          <li>
            <strong className="text-white/80">Read your traffic</strong> — All messages are
            encrypted with AES-256-GCM after the handshake
          </li>
          <li>
            <strong className="text-white/80">Forge messages</strong> — GCM provides authenticated
            encryption; tampered messages are rejected
          </li>
          <li>
            <strong className="text-white/80">Replay old messages</strong> — Each session derives
            fresh encryption keys
          </li>
        </ul>

        <h3 className="text-lg font-medium mt-6">Trust model</h3>
        <p className="text-white/60 leading-relaxed">
          The QR code or pairing link is the trust anchor. It contains the daemon's public key,
          which is required to establish the encrypted connection. Treat it like a password — don't
          share it publicly.
        </p>
        <p className="text-white/60 leading-relaxed">
          If you believe a pairing offer has been compromised, restart the daemon to generate a new
          session ID and rotate the relay pairing.
        </p>
      </section>

      {/* Direct Connection */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Direct connections</h2>
        <p className="text-white/60 leading-relaxed">
          By default, the daemon listens on <code className="font-mono">127.0.0.1:6767</code>{' '}
          (localhost only). This is safe for local CLI usage but not reachable from your phone or
          other devices.
        </p>

        <h3 className="text-lg font-medium mt-6">Socket file (CLI only)</h3>
        <p className="text-white/60 leading-relaxed">
          For maximum isolation, you can configure the daemon to listen on a Unix socket file
          instead of a TCP port. This prevents any network access entirely — only processes on the
          same machine can connect. The CLI supports this mode, but the mobile app and web interface
          require a network connection.
        </p>

        <h3 className="text-lg font-medium mt-6">VPN access</h3>
        <p className="text-white/60 leading-relaxed">
          If you prefer direct connections over the relay, you can use a VPN like{' '}
          <a
            href="https://tailscale.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white/80"
          >
            Tailscale
          </a>
          . Tailscale creates a private network between your devices, so you can access your daemon
          without exposing it to the public internet.
        </p>
        <p className="text-white/60 leading-relaxed">To set this up:</p>
        <ol className="text-white/60 space-y-2 list-decimal list-inside">
          <li>
            Install Tailscale on your machine and phone and join them to the same{' '}
            <a
              href="https://tailscale.com/kb/1136/tailnet"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/80"
            >
              tailnet
            </a>
          </li>
          <li>
            Configure the daemon to listen on your Tailscale IP (e.g.,{' '}
            <code className="font-mono">100.x.y.z:6767</code>)
          </li>
          <li>
            Add your Tailscale hostname to <code className="font-mono">allowedHosts</code> and{' '}
            <code className="font-mono">cors.allowedOrigins</code>
          </li>
          <li>Add the daemon as a direct connection in the Paseo app using the Tailscale address</li>
        </ol>

        <h3 className="text-lg font-medium mt-6">Binding to 0.0.0.0</h3>
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-white/80">
          <strong>Warning:</strong> Binding to <code className="font-mono">0.0.0.0</code> makes the
          daemon reachable on all network interfaces, including public Wi-Fi and local networks.
          This can expose your daemon to unauthorized access. If you must bind to all interfaces,
          ensure you have proper firewall rules and review your{' '}
          <code className="font-mono">allowedHosts</code> configuration.
        </div>
      </section>

      {/* DNS Rebinding Protection */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">DNS rebinding protection</h2>
        <p className="text-white/60 leading-relaxed">
          <strong className="text-white/80">CORS is not a complete security boundary.</strong> It
          controls which browser origins can make requests, but does not prevent a malicious website
          from resolving its domain to your local machine (DNS rebinding).
        </p>
        <p className="text-white/60 leading-relaxed">
          Paseo uses a host allowlist to validate the <code className="font-mono">Host</code> header
          on incoming requests. Requests with unrecognized hosts are rejected.
        </p>
        <p className="text-white/60 leading-relaxed">
          Configure via <code className="font-mono">daemon.allowedHosts</code> in{' '}
          <code className="font-mono">config.json</code>:
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            Default (<code className="font-mono">[]</code>): allow{' '}
            <code className="font-mono">localhost</code>,{' '}
            <code className="font-mono">*.localhost</code>, and all IP addresses
          </li>
          <li>
            <code className="font-mono">['.example.com']</code>: allow{' '}
            <code className="font-mono">example.com</code> and any subdomain, plus defaults
          </li>
          <li>
            <code className="font-mono">true</code>: allow any host (not recommended)
          </li>
        </ul>
      </section>

      {/* Agent Authentication */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Agent authentication</h2>
        <p className="text-white/60 leading-relaxed">
          Paseo wraps agent CLIs (Claude Code, Codex, OpenCode) but does not manage their
          authentication. Each agent provider handles its own credentials:
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <strong className="text-white/80">Claude Code</strong> — authenticates via Anthropic's
            OAuth flow, stored in <code className="font-mono">~/.claude/</code>
          </li>
          <li>
            <strong className="text-white/80">Codex</strong> — uses your OpenAI API key or OAuth
            session
          </li>
          <li>
            <strong className="text-white/80">OpenCode</strong> — configured via provider-specific
            API keys
          </li>
        </ul>
        <p className="text-white/60 leading-relaxed">
          Paseo never stores or transmits provider API keys. Agents run in your user context with
          your existing credentials.
        </p>
      </section>

      {/* Best Practices Summary */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Recommendations</h2>
        <ul className="text-white/60 space-y-3 list-disc list-inside">
          <li>
            <strong className="text-white/80">Use the relay</strong> for mobile access — it's the
            simplest option and all traffic is end-to-end encrypted
          </li>
          <li>
            <strong className="text-white/80">Treat the QR code like a password</strong> — anyone
            with the pairing offer can connect to your daemon
          </li>
          <li>
            <strong className="text-white/80">Never bind to 0.0.0.0</strong> unless you understand
            the implications and have proper firewall rules
          </li>
          <li>
            <strong className="text-white/80">Keep your daemon updated</strong> — security
            improvements are released regularly
          </li>
        </ul>
      </section>
    </div>
  )
}
