# Service Proxy

Paseo proxies HTTP traffic to services running inside your workspaces. Localhost service URLs are always enabled; optional public aliases and a separate service-only listener can be layered on through config.

## How it works

When a `paseo.json` script of `"type": "service"` starts, Paseo assigns it a local port and registers a route in the service proxy. Incoming requests whose `Host` header matches the script's generated hostname are forwarded to that port.

The generated hostname is built from the script name, branch, and project:

```
<script>--<branch>--<project>.localhost
```

If the branch is `main` or `master`, the branch segment is omitted:

```
<script>--<project>.localhost
```

**Example:** a script named `dev` in the `miniweb` project on branch `feature/auth` would be reachable at:

```
dev--feature-auth--miniweb.localhost
```

Local and public routes use one combined leftmost label (`script--branch--project`). This keeps the hostname compatible with normal single-level wildcard DNS and TLS. If the combined label would exceed DNS's 63-character label limit, Paseo truncates it with a deterministic hash suffix to avoid collisions.

## Configuration

Add a `serviceProxy` block under `daemon` in `~/.paseo/config.json`:

```json
{
  "version": 1,
  "daemon": {
    "serviceProxy": {
      "listen": "0.0.0.0:8080",
      "publicBaseUrl": "https://paseoapps.my.domain.com"
    }
  }
}
```

| Field           | Required | Description                                                                                                                                   |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen`        | No       | Starts a separate service-only listener at this address. If omitted, services are still reachable on the daemon listener via localhost hosts. |
| `publicBaseUrl` | No       | Adds public service host aliases and public service links. If omitted, links use localhost addresses only.                                    |

`enabled` is accepted for old configs but no longer enables a mode. `enabled: false` suppresses optional `listen`/`publicBaseUrl` layers only; localhost service proxying remains always enabled.

## DNS and reverse proxy setup

For generated URLs to be reachable, you need wildcard DNS pointing to the machine running the Paseo daemon.

**Example:** to expose services at `https://dev--miniweb.paseoapps.my.domain.com` where the daemon host is `10.1.1.1`:

1. Configure a wildcard DNS record:

   ```
   *.paseoapps.my.domain.com  →  10.1.1.1
   ```

2. Set `publicBaseUrl` to `https://paseoapps.my.domain.com` in your config.

3. If you put a reverse proxy (nginx, Caddy, Traefik, etc.) in front of Paseo, point it at either the daemon listener or the optional service-only listener and ensure it forwards the `Host` header unchanged. The proxy uses the `Host` header to route requests to the correct service — rewriting it will break routing.

Public service URLs expose the workspace service itself. Daemon password authentication protects daemon APIs; it does not protect proxied dev services.

Nginx example:

```nginx
server {
    listen 443 ssl;
    server_name *.paseoapps.my.domain.com;

    location / {
        proxy_pass http://10.1.1.1:8080;
        proxy_set_header Host $host;
    }
}
```

## Environment variables

The listen address and public base URL can also be set via environment variables, which take precedence over `config.json`:

| Variable                              | Description                                                               |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `PASEO_SERVICE_PROXY_ENABLED`         | Compatibility shim; `false` suppresses optional public/listen layers only |
| `PASEO_SERVICE_PROXY_LISTEN`          | Starts the optional service-only listener, e.g. `0.0.0.0:8080`            |
| `PASEO_SERVICE_PROXY_PUBLIC_BASE_URL` | Adds public service aliases and links                                     |
