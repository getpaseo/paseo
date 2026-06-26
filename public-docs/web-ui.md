---
title: Self-hosting the web UI
description: Serve the Paseo web app from your own daemon and reach it over your own LAN, VPN, reverse proxy, or tunnel.
nav: Web UI
order: 6
category: Getting started
---

# Self-hosting the web UI

Paseo's daemon can serve the browser web app itself, from the same address it already uses for the API. You don't need the hosted app at [app.paseo.sh](https://app.paseo.sh): point a browser at your own daemon and you get the full UI, connected to your own agents, on infrastructure you control.

This is useful when you want to:

- Run the whole UI on your own machine or server.
- Put it behind your own reverse proxy, HTTPS, or tunnel.
- Keep the setup self-hosted end to end, with no dependency on the hosted web app.

The web app ships inside the daemon package, so the UI you serve always matches your daemon version. There's no separate build to keep in sync and no UI-vs-daemon version skew to manage.

## Enable it

The bundled web UI is off by default. Turn it on when you start the daemon:

```bash
paseo daemon start --web-ui
```

Or with an environment variable:

```bash
PASEO_WEB_UI_ENABLED=true paseo daemon start
```

Or persist it in `config.json` so it survives restarts:

```json
{
  "features": {
    "webUi": {
      "enabled": true
    }
  }
}
```

Then open the daemon's address in a browser:

```
http://localhost:6767/
```

If your daemon doesn't recognize `--web-ui`, update it, the flag was added with the bundled web UI.

## How the connection works

The page is served from the same origin as the daemon's API and WebSocket. When you open it, the app automatically connects back to that same origin, so you usually skip the "Add Host" step entirely, open `http://localhost:6767/` and you're looking at your agents.

The same HTTP server keeps serving the API (`/api/*`), MCP (`/mcp/*`), service-proxy routes, and the WebSocket upgrade. Only the static files are new. To point the served UI at a _different_ daemon, add that daemon as a host from the UI as usual.

## Topologies

Three common ways to run it, in order of exposure:

- **Same machine.** Daemon and browser on one box. Open `http://localhost:6767/`. Nothing else to configure.
- **Private network (LAN or VPN).** Reach the daemon from other devices on a network you trust, a home LAN or a [Tailscale](https://tailscale.com) tailnet. Bind the daemon to that interface and connect to it by address.
- **Public reverse proxy or tunnel.** Expose the UI on a domain over HTTPS, terminating TLS at a reverse proxy or a tunnel. This is the full self-hosted setup.

The rest of this page builds from local to public. **Verify a direct connection works before you add a proxy in front of it**, it isolates daemon problems from proxy problems.

## Exposing beyond localhost

By default the daemon listens on `127.0.0.1:6767`, reachable only from the same machine. To reach it from other devices, bind it to a network interface:

```bash
paseo daemon start --web-ui --listen 0.0.0.0:6767
```

> **Anyone who can reach the listening address can use your agents.** Before you bind beyond localhost, set a password and review your host allowlist. The relay (the default mobile pairing path) avoids this entirely by keeping the daemon bound to localhost, see [Security](/docs/security).

Two things to configure when you expose the daemon directly:

1. **Set a password** so only authorized clients can connect:

   ```bash
   PASEO_PASSWORD=my-secret paseo daemon start --web-ui --listen 0.0.0.0:6767
   ```

   See [password authentication](/docs/configuration#password-authentication) for the persistent setup. Password auth controls access; it does not encrypt traffic, put TLS in front of it (below) on any untrusted network.

2. **Allow your hostname** so the daemon's DNS-rebinding protection accepts requests for your domain:

   ```bash
   paseo daemon start --web-ui --listen 0.0.0.0:6767 --hostnames ".example.com"
   ```

   See [DNS rebinding protection](/docs/security#dns-rebinding-protection) for how the host allowlist works.

> **The web app loads before authentication, by design.** The static UI files are served without the daemon password so the login screen can render; the API and WebSocket still require the password before any agent data is returned or any command runs. Don't treat "the page loaded" as "the daemon is open", but do set a password before binding to a network so the data behind the page stays protected.

## Reverse proxy

To serve the UI on a domain over HTTPS, terminate TLS at a reverse proxy and forward everything to the daemon. Keep the daemon on localhost and let the proxy be the only thing exposed.

A working proxy must:

- **Forward the WebSocket upgrade.** The app streams agent output over a WebSocket at `/ws`; without upgrade support the UI loads but never connects.
- **Not buffer responses.** Terminal output and other live streams are long-lived; buffering makes the UI look frozen.
- **Use long read timeouts.** Those streams stay open for the life of a session.
- **Allow large request bodies.** Prompts and file uploads can be big.
- **Preserve the `Host` header and pass `X-Forwarded-Proto`.** The daemon uses these to tell the app which origin and scheme (`wss://` vs `ws://`) to connect back on. Drop them and auto-connect points at the wrong place.

### Nginx

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  server_name paseo.example.com;

  ssl_certificate     /etc/letsencrypt/live/paseo.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/paseo.example.com/privkey.pem;

  client_max_body_size 100m;

  location / {
    proxy_pass http://127.0.0.1:6767;
    proxy_http_version 1.1;

    # WebSocket upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    # Preserve origin + scheme so the UI connects back over wss://
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # Long-lived, unbuffered streams
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

### Caddy

Caddy handles TLS, the WebSocket upgrade, header forwarding, and streaming for you:

```caddy
paseo.example.com {
  reverse_proxy 127.0.0.1:6767
}
```

That's the whole config. Caddy provisions a certificate automatically and preserves `Host` and `X-Forwarded-Proto` by default.

## HTTPS and TLS

Terminate TLS at the proxy (or tunnel) and forward to the daemon over plain HTTP on localhost, that's what the configs above do. When the page is served over HTTPS and the proxy passes `X-Forwarded-Proto: https`, the app automatically connects back over `wss://`. You don't configure the scheme anywhere; it follows the edge.

The daemon trusts forwarded headers from loopback proxies by default, which is what all the setups above do, the proxy or tunnel forwards to `127.0.0.1:6767`.

If your proxy reaches the daemon from another address, as in some Docker, LAN, or load-balancer setups, configure the trusted proxy ranges:

```json
{
  "daemon": {
    "trustedProxies": ["loopback", "172.16.0.0/12"]
  }
}
```

`PASEO_TRUSTED_PROXIES` accepts the same comma-separated values:

```bash
PASEO_TRUSTED_PROXIES=loopback,172.16.0.0/12 paseo daemon start --web-ui
```

Only use `trustedProxies: true` when your final trusted proxy overwrites client-supplied `X-Forwarded-*` headers. Otherwise a client could spoof forwarded header values.

If you serve the UI over HTTPS but the app tries to connect over `ws://` (and the browser blocks it as mixed content), your proxy isn't forwarding `X-Forwarded-Proto` or the daemon doesn't trust the proxy address. Fix whichever applies.

For the remote/relay path (driving a daemon through the Paseo relay rather than a reverse proxy), the relay has its own public-vs-internal TLS settings, see [Security](/docs/security).

## Tunnels

If you don't want to manage a reverse proxy or open ports, a tunnel gives you an HTTPS URL that forwards to your local daemon.

- **Tailscale Serve** keeps it inside your tailnet, no public exposure, TLS handled for you:

  ```bash
  tailscale serve https / http://127.0.0.1:6767
  ```

  Reach it at `https://<your-machine>.<tailnet>.ts.net/`. Only devices on your tailnet can connect.

- **Cloudflare Tunnel** exposes it on a public hostname with TLS and WebSocket support:

  ```bash
  cloudflared tunnel --url http://localhost:6767
  ```

  Cloudflare terminates TLS and sets `X-Forwarded-Proto: https`, so auto-connect works. Because the URL is public, **set a daemon password.**

## Security

Self-hosting the web UI puts you in charge of who can reach the daemon. The essentials:

- **Set a password before binding beyond localhost.** The static page loads without it, but agent data and commands stay behind it. See [Security](/docs/security#password-authentication).
- **Put TLS in front of any untrusted network.** Password auth protects access, not confidentiality.
- **Keep the daemon on localhost when you can** and let a reverse proxy or tunnel be the only exposed surface.
- **Review your host allowlist** when serving on a custom domain.

For the full threat model, relay encryption, and DNS-rebinding details, see [Security](/docs/security) and [SECURITY.md](https://github.com/getpaseo/paseo/blob/main/SECURITY.md).

## Troubleshooting

- **Blank page or 404 at `/`.** The web UI isn't enabled. Start the daemon with `--web-ui` and confirm with `paseo daemon status` that it's the daemon you're hitting.
- **Page loads but never connects.** The proxy isn't forwarding the WebSocket upgrade, or it's stripping the `Host` header. Check the upgrade headers in your proxy config.
- **Connects, then output freezes.** Response buffering is on, or read timeouts are too short. Disable buffering and raise the timeouts.
- **"Mixed content" / connection blocked over HTTPS.** The app fell back to `ws://`. Either the proxy isn't sending `X-Forwarded-Proto: https`, or the daemon doesn't trust the proxy address. Forward the header and configure `daemon.trustedProxies` if the proxy is not loopback.
- **`403 Invalid Host header`.** Your domain isn't in the allowlist. Add it with `--hostnames` or `daemon.hostnames`, see [DNS rebinding protection](/docs/security#dns-rebinding-protection).
- **Large prompts or uploads fail.** Raise the proxy's max body size (`client_max_body_size` in Nginx).

## See also

- [Security](/docs/security), connection methods, relay encryption, password auth, host allowlist.
- [Configuration](/docs/configuration), `config.json`, environment variables, and CLI overrides.
- [CLI](/docs/cli), the `paseo daemon` commands.
- [Community projects](/docs/community), community-built self-hosting tooling.
