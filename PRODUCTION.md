# Production Architecture

## Overview

Paseo ships as a headless daemon distributed via npm, with native apps (iOS/Android) and a bundled web UI. All communication is end-to-end encrypted. By default, the daemon connects to Paseo Link for remote access.

## Distribution

```bash
npm install -g @paseo/daemon
paseo start
```

The daemon package includes the web UI bundle, served at `http://localhost:6767`.

### Package Structure

```
@paseo/daemon
├── dist/
│   ├── cli.js          # Entry point
│   ├── server/         # Daemon code
│   └── public/         # Bundled web UI from @paseo/app
```

### CLI Commands

```bash
paseo start             # Run in foreground, connect to Link
paseo start --daemon    # Run in background
paseo start --no-link   # Direct connections only (for VPN/Tailscale users)
paseo stop              # Stop background daemon
paseo pair              # Generate pairing code
paseo devices           # List paired devices
paseo revoke <id>       # Remove a paired device
```

## Security Model

### Threat Model

Pairing protects against:
- Malicious JS on websites trying to connect to localhost
- Network attackers (misconfigured firewall, shared network)
- Link server snooping (E2EE - it only sees encrypted bytes)
- Unauthorized local network users

Not protected (out of scope):
- Malicious processes running as your user (already have full access)

### Device Pairing

Every device must pair with the daemon before communicating. Pairing is a one-time event per device.

**Flow:**

1. User runs `paseo pair`
2. Daemon generates one-time token (e.g., `K3X9-M2B7`), held in memory
3. Token displayed as QR code + plaintext
4. Client connects and presents token
5. ECDH key exchange → shared secret derived
6. Token invalidated, device stored as paired
7. All future communication encrypted with derived key

**Token format:**
- 8 alphanumeric characters (no ambiguous chars: 0/O, 1/l/I)
- Expires after 5 minutes or single use
- Example: `K3X9-M2B7`

**Stored per device:**

```typescript
interface PairedDevice {
  id: string
  name: string          // "Mohamed's iPhone"
  publicKey: string
  pairedAt: Date
  lastSeen: Date
}
```

### End-to-End Encryption

All communication is E2EE, regardless of transport:

```
┌─────────────────────────────────────────────────┐
│                   Transport                      │
│     (direct WS / Link / Tailscale / LAN)        │
└─────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│              E2EE Layer (always on)              │
│         Pairing token → key exchange             │
└─────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│              Application Protocol                │
└─────────────────────────────────────────────────┘
```

## Connectivity

### Paseo Link (default)

Remote access via `link.paseo.sh`:

```
Phone ──WS──▶ Cloudflare Edge ──▶ Durable Object (daemon-xyz)
                                         ▲
Daemon ──WS──▶ Cloudflare Edge ──────────┘
```

**Link properties:**
- Dumb pipe - forwards encrypted bytes only
- Cannot read traffic (E2EE)
- Stateful via Cloudflare Durable Objects
- Both daemon and clients routed to same DO instance by daemon ID
- Enabled by default, disable with `--no-link`

### Direct Access

For local network or VPN (Tailscale, etc.):

- Client connects directly to daemon WebSocket
- E2EE still required (paired device presents public key)
- No Link involved
- Use `paseo start --no-link` if you only want direct connections

**Pairing URL format:**

```
paseo://<daemon-id>@<link-or-direct-addr>?token=<one-time-pairing-token>
```

## Build & Bundling

### Web UI Bundling

The web UI is built from `@paseo/app` and copied into the daemon's dist:

```json
{
  "scripts": {
    "build:app": "npm run build --workspace=@paseo/app -- --platform web",
    "build:server": "tsc && cp -r ../app/dist/web ./dist/public",
    "build": "npm run build:app && npm run build:server"
  }
}
```

### Server Static Serving

```typescript
import express from 'express'
import path from 'path'

const app = express()

// API routes
app.use('/api', apiRouter)

// Static files - bundled web app
app.use(express.static(path.join(__dirname, 'public')))

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})
```

## Daemon Process Management

### Background Mode

```typescript
import { spawn } from 'child_process'
import fs from 'fs'

if (command === 'start' && process.argv.includes('--daemon')) {
  const child = spawn(process.execPath, [__filename, 'start'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  fs.writeFileSync('~/.paseo/daemon.pid', child.pid.toString())
  console.log(`Daemon started (pid: ${child.pid})`)
  process.exit(0)
}

if (command === 'stop') {
  const pid = fs.readFileSync('~/.paseo/daemon.pid', 'utf-8')
  process.kill(parseInt(pid))
  fs.unlinkSync('~/.paseo/daemon.pid')
  console.log('Daemon stopped')
}
```

### System Service (optional)

For auto-start on boot, users can install a system service:

**macOS (launchd):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.paseo.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/paseo</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

**Linux (systemd):**

```ini
[Unit]
Description=Paseo Daemon
After=network.target

[Service]
ExecStart=/usr/local/bin/paseo start
Restart=always
User=%u

[Install]
WantedBy=default.target
```

## Paseo Link Server (Cloudflare)

### Durable Object Implementation

```typescript
export class LinkRoom extends DurableObject {
  daemon: WebSocket | null = null
  clients: Map<string, WebSocket> = new Map()

  async fetch(req: Request) {
    const upgradeHeader = req.headers.get('Upgrade')
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const [client, server] = Object.values(new WebSocketPair())
    const role = req.headers.get('x-paseo-role')
    const clientId = req.headers.get('x-paseo-client-id')

    server.accept()

    if (role === 'daemon') {
      this.daemon = server
      server.addEventListener('message', (e) => {
        // Forward to all clients (they decrypt what's theirs)
        this.clients.forEach(c => c.send(e.data))
      })
    } else {
      this.clients.set(clientId, server)
      server.addEventListener('message', (e) => {
        this.daemon?.send(e.data)
      })
      server.addEventListener('close', () => {
        this.clients.delete(clientId)
      })
    }

    return new Response(null, { status: 101, webSocket: client })
  }
}
```

### Worker Entry Point

```typescript
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url)
    const daemonId = url.pathname.split('/')[2] // /link/<daemon-id>

    const id = env.LINK_ROOMS.idFromName(daemonId)
    const room = env.LINK_ROOMS.get(id)

    return room.fetch(req)
  }
}
```

### Pricing Estimate

- Durable Objects: $0.15/million requests
- WebSocket messages count as requests
- Storage: $0.15/GB-month (minimal for Link)
- Expected cost for personal use: < $1/month

## Future Enhancements

- **Homebrew formula** for easier Mac installation
- **Docker image** for server deployments
- **Bundled Node binary** (pkg/nexe) for non-Node users
- **Auto-update mechanism** via npm or custom updater
